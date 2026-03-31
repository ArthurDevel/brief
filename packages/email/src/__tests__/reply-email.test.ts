/**
 * Tests for reply email functionality.
 *
 * - Integration test: fetchReplyContext via Hoodiecrow (in-memory IMAP)
 * - Unit tests: replyToEmail via mocked nodemailer transport
 *
 * Responsibilities:
 * - Verify fetchReplyContext extracts correct threading and recipient info
 * - Verify replyToEmail sends with correct headers for reply and reply-all
 * - Verify Re: subject prefix is not doubled
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import hoodiecrow from "hoodiecrow-imap";
import type { SmtpConfig, ReplyContext } from "../types";
import { createImapConnection, closeImapConnection, fetchReplyContext } from "../imap-client";
import { replyToEmail } from "../smtp-client";

// ============================================================================
// CONSTANTS
// ============================================================================

const IMAP_PORT = 14_243;
const TEST_USER = "testuser";
const TEST_PASS = "testpass";

const SMTP_CONFIG: SmtpConfig = {
  host: "smtp.test.local",
  port: 587,
  user: "me@test.local",
  password: "testpass",
};

// ============================================================================
// HOODIECROW SEED DATA
// ============================================================================

/**
 * A message with known headers for fetchReplyContext testing.
 * Includes Message-ID, References, From, To (multiple), and CC (multiple).
 */
const REPLY_TARGET_MSG = {
  raw: [
    "From: Alice <alice@example.com>",
    "To: testuser@localhost, dave@example.com",
    "Cc: eve@example.com, frank@example.com",
    "Subject: Project update Q1",
    "Date: Mon, 10 Mar 2026 09:00:00 +0000",
    "Message-Id: <original-001@example.com>",
    "References: <parent-001@example.com> <parent-002@example.com>",
    "",
    "Here is the Q1 project update.",
  ].join("\r\n"),
};

function createTestServer() {
  return hoodiecrow({
    plugins: [
      "ID",
      "SASL-IR",
      "AUTH-PLAIN",
      "NAMESPACE",
      "IDLE",
      "ENABLE",
      "CONDSTORE",
      "LITERALPLUS",
      "UNSELECT",
      "SPECIAL-USE",
      "CREATE-SPECIAL-USE",
    ],
    storage: {
      INBOX: {
        messages: [REPLY_TARGET_MSG],
      },
      "": {
        separator: "/",
        folders: {
          "[Google Mail]": {
            flags: ["\\Noselect"],
            folders: {
              "All Mail": {
                "special-use": "\\All",
                messages: [REPLY_TARGET_MSG],
              },
              Drafts: { "special-use": "\\Drafts" },
              "Sent Mail": { "special-use": "\\Sent" },
              Trash: { "special-use": "\\Trash" },
            },
          },
        },
      },
    },
  });
}

// ============================================================================
// INTEGRATION TEST: fetchReplyContext
// ============================================================================

describe("fetchReplyContext (Hoodiecrow integration)", () => {
  let server: ReturnType<typeof hoodiecrow>;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = createTestServer();
        server.listen(IMAP_PORT, () => resolve());
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  it("returns correct messageId, references, from, to, cc, and subject", async () => {
    const client = await createImapConnection({
      host: "127.0.0.1",
      port: IMAP_PORT,
      user: TEST_USER,
      password: TEST_PASS,
      secure: false,
    });

    try {
      // UID "1" is the first (and only) message in INBOX
      const ctx = await fetchReplyContext(client, "1");

      expect(ctx.messageId).toBe("<original-001@example.com>");
      expect(ctx.references).toEqual([
        "<parent-001@example.com>",
        "<parent-002@example.com>",
      ]);
      expect(ctx.from).toBe("alice@example.com");
      expect(ctx.to).toEqual(["testuser@localhost", "dave@example.com"]);
      expect(ctx.cc).toEqual(["eve@example.com", "frank@example.com"]);
      expect(ctx.subject).toBe("Project update Q1");
    } finally {
      await closeImapConnection(client);
    }
  });
});

// ============================================================================
// UNIT TESTS: replyToEmail (mocked nodemailer)
// ============================================================================

// Mock nodemailer -- intercept createTransport to capture sendMail calls
vi.mock("nodemailer", () => {
  const sendMailMock = vi.fn().mockResolvedValue({ messageId: "<mock@test>" });
  return {
    default: {
      createTransport: vi.fn(() => ({
        sendMail: sendMailMock,
      })),
    },
  };
});

/**
 * Helper to get the mocked sendMail function from the mocked nodemailer module.
 */
async function getSendMailMock() {
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.default.createTransport({} as any);
  return transport.sendMail as ReturnType<typeof vi.fn>;
}

describe("replyToEmail (unit, mocked nodemailer)", () => {
  const BASE_CONTEXT: ReplyContext = {
    messageId: "<original-001@example.com>",
    references: ["<parent-001@example.com>"],
    from: "alice@example.com",
    to: ["me@test.local", "dave@example.com"],
    cc: ["eve@example.com"],
    subject: "Project update Q1",
  };

  it("replyAll=false sends to original sender only, with correct headers", async () => {
    const sendMail = await getSendMailMock();
    sendMail.mockClear();

    await replyToEmail(SMTP_CONFIG, BASE_CONTEXT, "Got it, thanks!", false, "me@test.local");

    expect(sendMail).toHaveBeenCalledTimes(1);
    const msg = sendMail.mock.calls[0][0];

    // To = original sender only
    expect(msg.to).toBe("alice@example.com");

    // No CC for simple reply
    expect(msg.cc).toBeUndefined();

    // Threading headers
    expect(msg.inReplyTo).toBe("<original-001@example.com>");
    expect(msg.references).toBe("<parent-001@example.com> <original-001@example.com>");

    // Subject gets Re: prefix
    expect(msg.subject).toBe("Re: Project update Q1");
  });

  it("replyAll=true sends to sender as To, original To+CC minus self as CC", async () => {
    const sendMail = await getSendMailMock();
    sendMail.mockClear();

    await replyToEmail(SMTP_CONFIG, BASE_CONTEXT, "Sounds good!", true, "me@test.local");

    expect(sendMail).toHaveBeenCalledTimes(1);
    const msg = sendMail.mock.calls[0][0];

    // To = original sender
    expect(msg.to).toBe("alice@example.com");

    // CC = original To + CC, minus our own address
    expect(msg.cc).toEqual(["dave@example.com", "eve@example.com"]);
  });

  it("does not double-prefix Re: when subject already starts with it", async () => {
    const sendMail = await getSendMailMock();
    sendMail.mockClear();

    const contextWithRe: ReplyContext = {
      ...BASE_CONTEXT,
      subject: "Re: Project update Q1",
    };

    await replyToEmail(SMTP_CONFIG, contextWithRe, "Thanks!", false, "me@test.local");

    expect(sendMail).toHaveBeenCalledTimes(1);
    const msg = sendMail.mock.calls[0][0];

    // Should remain "Re: ..." not "Re: Re: ..."
    expect(msg.subject).toBe("Re: Project update Q1");
  });
});
