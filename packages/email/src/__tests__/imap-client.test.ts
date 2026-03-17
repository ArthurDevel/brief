/**
 * Integration tests for IMAP client operations against a local Hoodiecrow server.
 *
 * Hoodiecrow provides an in-memory IMAP server with Gmail-style folder structure.
 * No Docker, no Java, no network — everything runs in-process.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import hoodiecrow from "hoodiecrow-imap";
import type { ImapConfig } from "../types";
import {
  createImapConnection,
  closeImapConnection,
  listInbox,
  searchEmails,
  readEmail,
  markAsRead,
  archiveEmail,
  deleteEmail,
  moveEmail,
} from "../imap-client";
import { saveDraft, deleteDraft } from "../smtp-client";

// ============================================================================
// TEST SERVER SETUP
// ============================================================================

const IMAP_PORT = 14_143;
const TEST_USER = "testuser";
const TEST_PASS = "testpass";

const SEED_MESSAGES = [
  {
    raw: [
      "From: Alice <alice@example.com>",
      "To: testuser@localhost",
      "Subject: Weekly standup notes",
      "Date: Mon, 10 Mar 2026 09:00:00 +0000",
      "Message-Id: <msg-001@example.com>",
      "",
      "Here are the notes from today's standup meeting.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Bob <bob@example.com>",
      "To: testuser@localhost",
      "Subject: Invoice #1234",
      "Date: Tue, 11 Mar 2026 14:30:00 +0000",
      "Message-Id: <msg-002@example.com>",
      "",
      "Please find attached the invoice for March.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Carol <carol@example.com>",
      "To: testuser@localhost",
      "Subject: Lunch tomorrow?",
      "Date: Wed, 12 Mar 2026 11:00:00 +0000",
      "Message-Id: <msg-003@example.com>",
      "",
      "Hey, want to grab lunch tomorrow at noon?",
    ].join("\r\n"),
  },
];

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
        messages: SEED_MESSAGES,
      },
      "": {
        separator: "/",
        folders: {
          "[Gmail]": {
            flags: ["\\Noselect"],
            folders: {
              "All Mail": { "special-use": "\\All" },
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

const imapConfig: ImapConfig = {
  host: "127.0.0.1",
  port: IMAP_PORT,
  user: TEST_USER,
  password: TEST_PASS,
  secure: false,
};

// ============================================================================
// TESTS
// ============================================================================

describe("IMAP client (Hoodiecrow integration)", () => {
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

  // --------------------------------------------------------------------------
  // Connection
  // --------------------------------------------------------------------------

  it("connects and disconnects cleanly", async () => {
    const client = await createImapConnection(imapConfig);
    await closeImapConnection(client);
  });

  // --------------------------------------------------------------------------
  // listInbox
  // --------------------------------------------------------------------------

  it("lists inbox emails in reverse chronological order", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const emails = await listInbox(client, 10);

      expect(emails.length).toBe(3);
      // Most recent first
      expect(emails[0].subject).toBe("Lunch tomorrow?");
      expect(emails[1].subject).toBe("Invoice #1234");
      expect(emails[2].subject).toBe("Weekly standup notes");
    } finally {
      await closeImapConnection(client);
    }
  });

  it("respects the limit parameter", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const emails = await listInbox(client, 2);
      expect(emails.length).toBe(2);
    } finally {
      await closeImapConnection(client);
    }
  });

  it("returns from and date fields", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const emails = await listInbox(client, 10);
      const alice = emails.find((e) => e.subject === "Weekly standup notes")!;

      expect(alice.from).toContain("Alice");
      expect(alice.from).toContain("alice@example.com");
      expect(alice.date).toBeTruthy();
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // searchEmails
  // --------------------------------------------------------------------------

  it("searches by subject", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const results = await searchEmails(client, "Invoice");
      expect(results.length).toBe(1);
      expect(results[0].subject).toBe("Invoice #1234");
    } finally {
      await closeImapConnection(client);
    }
  });

  it("searches by sender", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const results = await searchEmails(client, "carol@example.com");
      expect(results.length).toBe(1);
      expect(results[0].subject).toBe("Lunch tomorrow?");
    } finally {
      await closeImapConnection(client);
    }
  });

  it("returns empty array for no matches", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const results = await searchEmails(client, "nonexistent-query-xyz");
      expect(results).toEqual([]);
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // readEmail
  // --------------------------------------------------------------------------

  it("reads full email content by UID", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      // First, list to get a UID
      const emails = await listInbox(client, 10);
      const bobEmail = emails.find((e) => e.subject === "Invoice #1234")!;

      const full = await readEmail(client, bobEmail.id);
      expect(full.subject).toBe("Invoice #1234");
      expect(full.from).toContain("Bob");
      expect(full.to).toContain("testuser@localhost");
      expect(full.body).toContain("invoice for March");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // markAsRead
  // --------------------------------------------------------------------------

  it("marks an email as read", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const emails = await listInbox(client, 10);
      const target = emails[0];

      await markAsRead(client, target.id);

      // Verify the Seen flag is set
      const full = await readEmail(client, target.id);
      expect(full.isRead).toBe(true);
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // archiveEmail + undo
  // --------------------------------------------------------------------------

  it("archives an email and undoes it", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const before = await listInbox(client, 10);
      const target = before.find((e) => e.subject === "Weekly standup notes")!;

      // Archive
      const undoRecipe = await archiveEmail(client, target.id, "INBOX");
      expect(undoRecipe.operation).toBe("move_email");
      expect(undoRecipe.params.from).toBe("[Gmail]/All Mail");
      expect(undoRecipe.params.to).toBe("INBOX");

      // Verify it left the inbox
      const after = await listInbox(client, 10);
      const found = after.find((e) => e.subject === "Weekly standup notes");
      expect(found).toBeUndefined();

      // Undo — move it back
      await moveEmail(
        client,
        undoRecipe.params.emailId as string,
        undoRecipe.params.from as string,
        undoRecipe.params.to as string,
      );

      // Verify it's back
      const restored = await listInbox(client, 10);
      const back = restored.find((e) => e.subject === "Weekly standup notes");
      expect(back).toBeDefined();
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // deleteEmail + undo
  // --------------------------------------------------------------------------

  it("deletes an email to trash and returns an undo recipe", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const before = await listInbox(client, 10);
      const target = before.find((e) => e.subject === "Lunch tomorrow?")!;

      // Delete
      const undoRecipe = await deleteEmail(client, target.id, "INBOX");
      expect(undoRecipe.operation).toBe("move_email");
      expect(undoRecipe.params.from).toBe("[Gmail]/Trash");
      expect(undoRecipe.params.to).toBe("INBOX");

      // Verify it left the inbox
      const after = await listInbox(client, 10);
      const found = after.find((e) => e.subject === "Lunch tomorrow?");
      expect(found).toBeUndefined();
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // saveDraft + deleteDraft
  // --------------------------------------------------------------------------

  it("saves a draft and deletes it", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const undoRecipe = await saveDraft(client, {
        to: "someone@example.com",
        subject: "Test draft",
        body: "This is a draft body.",
      });

      expect(undoRecipe.operation).toBe("delete_draft");
      expect(undoRecipe.params.draftUid).toBeDefined();

      // Clean up
      await deleteDraft(client, undoRecipe.params.draftUid as string);
    } finally {
      await closeImapConnection(client);
    }
  });
});
