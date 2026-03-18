/**
 * Integration tests for the action queue: execute and undo flows.
 *
 * Uses Hoodiecrow (in-memory IMAP server) for real email operations
 * and a lightweight fake Supabase for database state.
 *
 * Tests verify actual outcomes (emails moved, drafts created/deleted,
 * status transitions) rather than implementation details.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import hoodiecrow from "hoodiecrow-imap";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImapConfig } from "@dublin/email";
import {
  createImapConnection,
  closeImapConnection,
  listInbox,
} from "@dublin/email";
import { executeAction, undoAction } from "../action-queue";

// ============================================================================
// TEST SERVER SETUP
// ============================================================================

const IMAP_PORT = 14_243; // Different port from email package tests
const TEST_USER = "testuser";
const TEST_PASS = "testpass";

const SEED_MESSAGES = [
  {
    raw: [
      "From: Alice <alice@example.com>",
      "To: testuser@localhost",
      "Subject: Weekly standup notes",
      "Date: Mon, 10 Mar 2026 09:00:00 +0000",
      "Message-Id: <aq-msg-001@example.com>",
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
      "Message-Id: <aq-msg-002@example.com>",
      "",
      "Please find attached the invoice for March.",
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
        messages: [...SEED_MESSAGES],
      },
      "": {
        separator: "/",
        folders: {
          "[Google Mail]": {
            flags: ["\\Noselect"],
            folders: {
              "All Mail": {
                "special-use": "\\All",
                messages: [...SEED_MESSAGES],
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

const imapConfig: ImapConfig = {
  host: "127.0.0.1",
  port: IMAP_PORT,
  user: TEST_USER,
  password: TEST_PASS,
  secure: false,
};

const DUMMY_SMTP_CONFIG = {
  host: "localhost",
  port: 587,
  user: "test",
  password: "test",
};

// ============================================================================
// FAKE SUPABASE
// ============================================================================

type Row = Record<string, unknown>;

/**
 * Creates a minimal fake Supabase client backed by an in-memory store.
 * Supports the chained query patterns used in action-queue.ts:
 *   .from(table).select().eq().single()
 *   .from(table).update().eq()
 * @param store - In-memory store keyed by table name, then by row ID
 * @returns A fake SupabaseClient
 */
function createFakeSupabase(store: Record<string, Record<string, Row>>) {
  return {
    from(table: string) {
      const rows = (store[table] ??= {});

      return {
        select(_cols: string) {
          return {
            eq(col: string, value: unknown) {
              return {
                single: () => {
                  const row = Object.values(rows).find((r) => r[col] === value);
                  if (!row) return Promise.resolve({ data: null, error: { message: "not found" } });
                  return Promise.resolve({ data: { ...row }, error: null });
                },
              };
            },
          };
        },

        update(values: Row) {
          return {
            eq: (col: string, value: unknown) => {
              const row = Object.values(rows).find((r) => r[col] === value);
              if (row) Object.assign(row, values);
              return Promise.resolve({ error: null });
            },
          };
        },

        insert(newRow: Row) {
          const id = (newRow.id as string) ?? crypto.randomUUID();
          rows[id] = { ...newRow, id };
          return {
            select(_cols: string) {
              return {
                single: () => Promise.resolve({ data: { id }, error: null }),
              };
            },
          };
        },

        delete() {
          return {
            eq: (col: string, value: unknown) => {
              const key = Object.keys(rows).find((k) => rows[k][col] === value);
              if (key) delete rows[key];
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

/**
 * Creates a pending action row in the fake store.
 * @param id - Action ID
 * @param toolName - The tool to execute
 * @param args - Tool arguments
 * @returns The row object (also stored in the returned store)
 */
function makePendingAction(
  id: string,
  toolName: string,
  args: Record<string, unknown>
): { store: Record<string, Record<string, Row>>; supabase: SupabaseClient } {
  const store: Record<string, Record<string, Row>> = {
    actions: {
      [id]: {
        id,
        user_id: "user-1",
        session_id: "session-1",
        tool_name: toolName,
        arguments: args,
        status: "pending",
        requires_approval: true,
        result: null,
        undo_recipe: null,
        undo_deadline: null,
        created_at: new Date().toISOString(),
        executed_at: null,
      },
    },
  };

  return { store, supabase: createFakeSupabase(store) };
}

// ============================================================================
// TESTS
// ============================================================================

describe("Action queue (Hoodiecrow integration)", () => {
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
  // Execute archive
  // --------------------------------------------------------------------------

  it("executes an archive action: email leaves inbox, undo recipe stored", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const emails = await listInbox(client, 10);
      const target = emails.find((e) => e.subject === "Weekly standup notes")!;
      expect(target).toBeDefined();

      const { store, supabase } = makePendingAction("a1", "archive_email", {
        email_id: target.id,
        source_folder: "INBOX",
      });

      const result = await executeAction("a1", supabase, client, DUMMY_SMTP_CONFIG);

      // Email should have left the inbox
      const after = await listInbox(client, 10);
      expect(after.find((e) => e.subject === "Weekly standup notes")).toBeUndefined();

      // Action should be executed with a move_email undo recipe
      expect(result.status).toBe("executed");
      const action = store.actions["a1"];
      expect(action.status).toBe("executed");
      expect(action.undo_recipe).toMatchObject({ operation: "move_email" });
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Execute archive + undo
  // --------------------------------------------------------------------------

  it("undoes an archive action: email returns to inbox", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const emails = await listInbox(client, 10);
      const target = emails.find((e) => e.subject === "Invoice #1234")!;
      expect(target).toBeDefined();

      const { store, supabase } = makePendingAction("a2", "archive_email", {
        email_id: target.id,
        source_folder: "INBOX",
      });

      // Execute first
      await executeAction("a2", supabase, client, DUMMY_SMTP_CONFIG);
      const mid = await listInbox(client, 10);
      expect(mid.find((e) => e.subject === "Invoice #1234")).toBeUndefined();

      // Undo
      const undoResult = await undoAction("a2", supabase, client);

      // Email should be back in inbox
      const after = await listInbox(client, 10);
      expect(after.find((e) => e.subject === "Invoice #1234")).toBeDefined();
      expect(undoResult.success).toBe(true);
      expect(store.actions["a2"].status).toBe("undone");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Execute delete + undo
  // --------------------------------------------------------------------------

  it("undoes a delete action: email returns to inbox from trash", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const emails = await listInbox(client, 10);
      const target = emails.find((e) => e.subject === "Invoice #1234")!;
      expect(target).toBeDefined();

      const { store, supabase } = makePendingAction("a-del", "delete_email", {
        email_id: target.id,
        source_folder: "INBOX",
      });

      // Execute delete
      await executeAction("a-del", supabase, client, DUMMY_SMTP_CONFIG);
      const mid = await listInbox(client, 10);
      expect(mid.find((e) => e.subject === "Invoice #1234")).toBeUndefined();

      // Undo
      const undoResult = await undoAction("a-del", supabase, client);

      // Email should be back in inbox
      const after = await listInbox(client, 10);
      expect(after.find((e) => e.subject === "Invoice #1234")).toBeDefined();
      expect(undoResult.success).toBe(true);
      expect(store.actions["a-del"].status).toBe("undone");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Execute draft
  // --------------------------------------------------------------------------

  it("executes a draft action: draft created, delete_draft undo recipe stored", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const { store, supabase } = makePendingAction("a3", "draft_email", {
        to: "someone@example.com",
        subject: "Test draft",
        body: "Draft body.",
      });

      const result = await executeAction("a3", supabase, client, DUMMY_SMTP_CONFIG);

      expect(result.status).toBe("executed");
      const action = store.actions["a3"];
      expect(action.undo_recipe).toMatchObject({ operation: "delete_draft" });
      expect((action.undo_recipe as Record<string, unknown>).params).toHaveProperty("draftUid");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Execute draft + undo
  // --------------------------------------------------------------------------

  it("undoes a draft action: draft deleted", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const { store, supabase } = makePendingAction("a4", "draft_email", {
        to: "someone@example.com",
        subject: "Undo draft test",
        body: "This will be undone.",
      });

      await executeAction("a4", supabase, client, DUMMY_SMTP_CONFIG);

      const undoResult = await undoAction("a4", supabase, client);

      expect(undoResult.success).toBe(true);
      expect(store.actions["a4"].status).toBe("undone");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Guard rails
  // --------------------------------------------------------------------------

  it("rejects execution of an already-executed action", async () => {
    const store: Record<string, Record<string, Row>> = {
      actions: {
        "a5": {
          id: "a5",
          user_id: "user-1",
          tool_name: "archive_email",
          arguments: {},
          status: "executed",
        },
      },
    };
    const supabase = createFakeSupabase(store);
    const client = await createImapConnection(imapConfig);

    try {
      await expect(
        executeAction("a5", supabase, client, DUMMY_SMTP_CONFIG),
      ).rejects.toThrow("cannot be executed");
    } finally {
      await closeImapConnection(client);
    }
  });

  it("rejects undo of a non-executed action", async () => {
    const store: Record<string, Record<string, Row>> = {
      actions: {
        "a6": {
          id: "a6",
          user_id: "user-1",
          tool_name: "archive_email",
          arguments: {},
          status: "pending",
          undo_recipe: null,
        },
      },
    };
    const supabase = createFakeSupabase(store);
    const client = await createImapConnection(imapConfig);

    try {
      const result = await undoAction("a6", supabase, client);
      expect(result.success).toBe(false);
    } finally {
      await closeImapConnection(client);
    }
  });
});
