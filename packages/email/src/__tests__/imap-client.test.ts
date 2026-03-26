/**
 * Integration tests for IMAP client operations against a local Hoodiecrow server.
 *
 * Hoodiecrow provides an in-memory IMAP server with Gmail-style folder structure.
 * No Docker, no Java, no network — everything runs in-process.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import hoodiecrow from "hoodiecrow-imap";
import type { ImapConfig, EmailMetaRequest } from "../types";
import {
  createImapConnection,
  closeImapConnection,
  listInbox,
  searchEmails,
  readEmail,
  readThread,
  markAsRead,
  archiveEmail,
  deleteEmail,
  moveEmail,
  listFolders,
  moveEmailToFolder,
  fetchEmailMetaBatch,
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

// A 3-message email thread: Alice starts, user replies, Alice responds.
// In Gmail, All Mail contains both sent and received messages.
const THREAD_MSG_1 = {
  raw: [
    "From: Alice <alice@example.com>",
    "To: testuser@localhost",
    "Subject: Project kickoff",
    "Date: Thu, 13 Mar 2026 10:00:00 +0000",
    "Message-Id: <thread-001@example.com>",
    "",
    "Let's get started on the project. When can you begin?",
  ].join("\r\n"),
};

const THREAD_MSG_2 = {
  raw: [
    "From: testuser@localhost",
    "To: Alice <alice@example.com>",
    "Subject: Re: Project kickoff",
    "Date: Thu, 13 Mar 2026 11:30:00 +0000",
    "Message-Id: <thread-002@example.com>",
    "In-Reply-To: <thread-001@example.com>",
    "References: <thread-001@example.com>",
    "",
    "I can start next Monday. Does that work?",
  ].join("\r\n"),
};

const THREAD_MSG_3 = {
  raw: [
    "From: Alice <alice@example.com>",
    "To: testuser@localhost",
    "Subject: Re: Project kickoff",
    "Date: Thu, 13 Mar 2026 14:00:00 +0000",
    "Message-Id: <thread-003@example.com>",
    "In-Reply-To: <thread-002@example.com>",
    "References: <thread-001@example.com> <thread-002@example.com>",
    "",
    "Monday works! See you then.",
  ].join("\r\n"),
};

// A message that only exists in Trash (not in INBOX or All Mail).
const TRASH_ONLY_MSG = {
  raw: [
    "From: Dave <dave@example.com>",
    "To: testuser@localhost",
    "Subject: Old promo offer",
    "Date: Sun, 09 Mar 2026 08:00:00 +0000",
    "Message-Id: <trash-only-001@example.com>",
    "",
    "This promotional offer has expired.",
  ].join("\r\n"),
};

/**
 * Creates a Hoodiecrow server with a non-standard folder prefix.
 * Real Gmail accounts may use "[Google Mail]" or localized names instead of "[Gmail]".
 * The IMAP client must discover folders via SPECIAL-USE flags, not hardcoded paths.
 */
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
        messages: [...SEED_MESSAGES, THREAD_MSG_1, THREAD_MSG_3],
      },
      "": {
        separator: "/",
        folders: {
          "[Google Mail]": {
            flags: ["\\Noselect"],
            folders: {
              "All Mail": {
                "special-use": "\\All",
                messages: [...SEED_MESSAGES, THREAD_MSG_1, THREAD_MSG_2, THREAD_MSG_3],
              },
              Drafts: { "special-use": "\\Drafts" },
              "Sent Mail": {
                "special-use": "\\Sent",
                messages: [THREAD_MSG_2],
              },
              Trash: {
                "special-use": "\\Trash",
                messages: [TRASH_ONLY_MSG],
              },
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

      expect(emails.length).toBe(5);
      // Most recent first — thread messages are newest
      expect(emails[0].subject).toBe("Re: Project kickoff");
      expect(emails[1].subject).toBe("Project kickoff");
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
  // fetchEmailMetaBatch
  // --------------------------------------------------------------------------

  it("returns correct subject/from for multiple UIDs", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const requests: EmailMetaRequest[] = [
        { actionId: "a1", uid: "1" },
        { actionId: "a2", uid: "2" },
        { actionId: "a3", uid: "3" },
      ];

      const results = await fetchEmailMetaBatch(client, requests);

      expect(results.size).toBe(3);

      expect(results.get("a1")!.subject).toBe("Weekly standup notes");
      expect(results.get("a1")!.from).toContain("Alice");

      expect(results.get("a2")!.subject).toBe("Invoice #1234");
      expect(results.get("a2")!.from).toContain("Bob");

      expect(results.get("a3")!.subject).toBe("Lunch tomorrow?");
      expect(results.get("a3")!.from).toContain("Carol");
    } finally {
      await closeImapConnection(client);
    }
  });

  it("returns correct subject/from for multiple message_ids", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const requests: EmailMetaRequest[] = [
        { actionId: "b1", messageId: "<msg-001@example.com>" },
        { actionId: "b2", messageId: "<msg-002@example.com>" },
      ];

      const results = await fetchEmailMetaBatch(client, requests);

      expect(results.size).toBe(2);

      expect(results.get("b1")!.subject).toBe("Weekly standup notes");
      expect(results.get("b1")!.from).toContain("Alice");

      expect(results.get("b2")!.subject).toBe("Invoice #1234");
      expect(results.get("b2")!.from).toContain("Bob");
    } finally {
      await closeImapConnection(client);
    }
  });

  it("finds a message_id that only exists in Trash", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const requests: EmailMetaRequest[] = [
        { actionId: "c1", messageId: "<trash-only-001@example.com>" },
      ];

      const results = await fetchEmailMetaBatch(client, requests);

      expect(results.size).toBe(1);
      expect(results.get("c1")!.subject).toBe("Old promo offer");
      expect(results.get("c1")!.from).toContain("Dave");
    } finally {
      await closeImapConnection(client);
    }
  });

  it("handles a mix of UID-based and message_id-based lookups", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const requests: EmailMetaRequest[] = [
        { actionId: "d1", uid: "1" },
        { actionId: "d2", messageId: "<msg-002@example.com>" },
        { actionId: "d3", uid: "3" },
      ];

      const results = await fetchEmailMetaBatch(client, requests);

      expect(results.size).toBe(3);

      expect(results.get("d1")!.subject).toBe("Weekly standup notes");
      expect(results.get("d2")!.subject).toBe("Invoice #1234");
      expect(results.get("d3")!.subject).toBe("Lunch tomorrow?");
    } finally {
      await closeImapConnection(client);
    }
  });

  it("returns partial results when some lookups fail", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const requests: EmailMetaRequest[] = [
        { actionId: "e1", uid: "1" },
        { actionId: "e2", uid: "99999" },
        { actionId: "e3", uid: "2" },
      ];

      const results = await fetchEmailMetaBatch(client, requests);

      // Valid UIDs should be in the results
      expect(results.has("e1")).toBe(true);
      expect(results.has("e3")).toBe(true);
      expect(results.get("e1")!.subject).toBe("Weekly standup notes");
      expect(results.get("e3")!.subject).toBe("Invoice #1234");

      // Nonexistent UID should NOT be in the results
      expect(results.has("e2")).toBe(false);
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

  it("archives an email and returns an undo recipe", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const before = await listInbox(client, 10);
      const target = before.find((e) => e.subject === "Weekly standup notes")!;

      // Archive
      const undoRecipe = await archiveEmail(client, target.id, "INBOX");
      expect(undoRecipe.operation).toBe("move_email");
      // Should discover the All Mail folder dynamically, not hardcode [Gmail]
      expect(undoRecipe.params.from).toContain("All Mail");
      expect(undoRecipe.params.to).toBe("INBOX");

      // Verify it left the inbox
      const after = await listInbox(client, 10);
      const found = after.find((e) => e.subject === "Weekly standup notes");
      expect(found).toBeUndefined();
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
      expect(undoRecipe.params.from).toContain("Trash");
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

  // --------------------------------------------------------------------------
  // readThread
  // --------------------------------------------------------------------------

  it("returns full thread including sent messages, in chronological order", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      // Find the first thread message in INBOX
      const emails = await listInbox(client, 10);
      const kickoff = emails.find((e) => e.subject === "Project kickoff")!;
      expect(kickoff).toBeDefined();

      // Read the full thread starting from this email
      const thread = await readThread(client, kickoff.id);

      // Should return all 3 messages (2 received + 1 sent reply)
      expect(thread).toHaveLength(3);

      // Chronological order (oldest first)
      expect(thread[0].body).toContain("Let's get started");
      expect(thread[0].from).toContain("alice@example.com");

      expect(thread[1].body).toContain("I can start next Monday");
      expect(thread[1].from).toContain("testuser@localhost");

      expect(thread[2].body).toContain("Monday works");
      expect(thread[2].from).toContain("alice@example.com");
    } finally {
      await closeImapConnection(client);
    }
  });

  it("returns a single-message thread for emails with no replies", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const emails = await listInbox(client, 10);
      const invoice = emails.find((e) => e.subject === "Invoice #1234")!;

      const thread = await readThread(client, invoice.id);

      expect(thread).toHaveLength(1);
      expect(thread[0].subject).toBe("Invoice #1234");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // saveDraft + deleteDraft
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // listFolders
  // --------------------------------------------------------------------------

  it("lists all selectable folders excluding INBOX and non-selectable parents", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const folders = await listFolders(client);
      const paths = folders.map((f) => f.path);

      // Should include special-use folders
      expect(paths).toContain("[Google Mail]/All Mail");
      expect(paths).toContain("[Google Mail]/Trash");
      expect(paths).toContain("[Google Mail]/Drafts");
      expect(paths).toContain("[Google Mail]/Sent Mail");

      // Should NOT include INBOX
      expect(paths).not.toContain("INBOX");

      // Should NOT include the non-selectable [Google Mail] parent
      expect(paths).not.toContain("[Google Mail]");

      // Verify display names are the last path segment
      const allMail = folders.find((f) => f.path === "[Google Mail]/All Mail")!;
      expect(allMail.name).toBe("All Mail");
      expect(allMail.specialUse).toBe("\\All");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // moveEmailToFolder
  // --------------------------------------------------------------------------

  it("moves an email to a target folder and returns an undo recipe", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const before = await listInbox(client, 10);
      const target = before.find((e) => e.subject === "Invoice #1234")!;
      expect(target).toBeDefined();

      // Move to Drafts folder
      const undoRecipe = await moveEmailToFolder(
        client,
        target.id,
        "[Google Mail]/Drafts",
        "INBOX"
      );

      expect(undoRecipe.operation).toBe("move_email");
      expect(undoRecipe.params.from).toBe("[Google Mail]/Drafts");
      expect(undoRecipe.params.to).toBe("INBOX");
      expect(undoRecipe.params.messageId).toBeDefined();

      // Verify it left the inbox
      const after = await listInbox(client, 10);
      const found = after.find((e) => e.subject === "Invoice #1234");
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
