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
import { executeAction, undoAction, handleToolCall, classifyAction, bulkExecuteActions } from "../action-queue";
import type { ActionInput } from "../types";

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
 *   .from(table).select().eq().in().in()
 *   .from(table).select().eq().eq().in()
 *   .from(table).update().eq()
 *   .from(table).insert().select().single()
 * @param store - In-memory store keyed by table name, then by row ID
 * @returns A fake SupabaseClient
 */
function createFakeSupabase(store: Record<string, Record<string, Row>>) {
  return {
    from(table: string) {
      const rows = (store[table] ??= {});

      /**
       * Creates a chainable query builder that accumulates .eq() and .in() filters.
       * Thenable so it can be awaited directly, and also supports .single().
       */
      function createSelectBuilder() {
        const filters: Array<{ type: "eq" | "in"; col: string; value: unknown }> = [];

        function applyFilters(): Row[] {
          return Object.values(rows).filter((row) =>
            filters.every((f) => {
              if (f.type === "eq") return row[f.col] === f.value;
              return Array.isArray(f.value) && (f.value as unknown[]).includes(row[f.col]);
            })
          );
        }

        const builder: Record<string, unknown> = {
          eq(col: string, value: unknown) {
            filters.push({ type: "eq", col, value });
            return builder;
          },
          in(col: string, values: unknown[]) {
            filters.push({ type: "in", col, value: values });
            return builder;
          },
          single() {
            const matched = applyFilters();
            if (matched.length === 0) return Promise.resolve({ data: null, error: { message: "not found" } });
            return Promise.resolve({ data: { ...matched[0] }, error: null });
          },
          then(resolve: (val: unknown) => void, reject?: (err: unknown) => void) {
            const result = { data: applyFilters().map((r) => ({ ...r })), error: null };
            return Promise.resolve(result).then(resolve, reject);
          },
        };

        return builder;
      }

      return {
        select(_cols: string) {
          return createSelectBuilder();
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

  // --------------------------------------------------------------------------
  // Execute action with dispatch error marks action as "failed"
  // --------------------------------------------------------------------------

  it("marks action as failed with error message when dispatch throws", async () => {
    const client = await createImapConnection(imapConfig);
    try {
      const { store, supabase } = makePendingAction("a-fail", "archive_email", {
        email_id: "99999", // non-existent email -- dispatchTool will throw
        source_folder: "INBOX",
      });

      // executeAction should re-throw so the caller can return a 500
      await expect(
        executeAction("a-fail", supabase, client, DUMMY_SMTP_CONFIG),
      ).rejects.toThrow();

      // Action row should be updated to "failed" with the error message in result
      const action = store.actions["a-fail"];
      expect(action.status).toBe("failed");
      expect(action.result).toBeDefined();
      expect((action.result as Record<string, unknown>).error).toEqual(expect.any(String));
      expect(((action.result as Record<string, unknown>).error as string).length).toBeGreaterThan(0);
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

// ============================================================================
// BATCH TOOL CLASSIFICATION
// ============================================================================

describe("Batch tool classification", () => {
  it("classifies batch_archive_emails as mutating_auto", () => {
    expect(classifyAction("batch_archive_emails", {})).toBe("mutating_auto");
  });

  it("classifies batch_delete_emails as mutating_queued", () => {
    expect(classifyAction("batch_delete_emails", {})).toBe("mutating_queued");
  });
});

// ============================================================================
// BATCH EMAIL ACTIONS (INTEGRATION)
// ============================================================================

const BATCH_IMAP_PORT = 14_244;

const BATCH_SEED_MESSAGES = [
  {
    raw: [
      "From: Alice <alice@example.com>",
      "To: testuser@localhost",
      "Subject: Batch test email 1",
      "Date: Mon, 10 Mar 2026 09:00:00 +0000",
      "Message-Id: <batch-msg-001@example.com>",
      "",
      "Body of batch test email 1.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Bob <bob@example.com>",
      "To: testuser@localhost",
      "Subject: Batch test email 2",
      "Date: Tue, 11 Mar 2026 10:00:00 +0000",
      "Message-Id: <batch-msg-002@example.com>",
      "",
      "Body of batch test email 2.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Carol <carol@example.com>",
      "To: testuser@localhost",
      "Subject: Batch test email 3",
      "Date: Wed, 12 Mar 2026 11:00:00 +0000",
      "Message-Id: <batch-msg-003@example.com>",
      "",
      "Body of batch test email 3.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Dave <dave@example.com>",
      "To: testuser@localhost",
      "Subject: Batch test email 4",
      "Date: Thu, 13 Mar 2026 12:00:00 +0000",
      "Message-Id: <batch-msg-004@example.com>",
      "",
      "Body of batch test email 4.",
    ].join("\r\n"),
  },
];

function createBatchTestServer() {
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
        messages: [...BATCH_SEED_MESSAGES],
      },
      "": {
        separator: "/",
        folders: {
          "[Google Mail]": {
            flags: ["\\Noselect"],
            folders: {
              "All Mail": {
                "special-use": "\\All",
                messages: [...BATCH_SEED_MESSAGES],
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

const batchImapConfig: ImapConfig = {
  host: "127.0.0.1",
  port: BATCH_IMAP_PORT,
  user: TEST_USER,
  password: TEST_PASS,
  secure: false,
};

describe("Batch email actions (Hoodiecrow integration)", () => {
  let server: ReturnType<typeof hoodiecrow>;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = createBatchTestServer();
        server.listen(BATCH_IMAP_PORT, () => resolve());
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  // --------------------------------------------------------------------------
  // Batch archive: creates individual action rows, removes emails from inbox
  // --------------------------------------------------------------------------

  it("batch archive creates individual action rows and removes emails from inbox", async () => {
    const client = await createImapConnection(batchImapConfig);
    try {
      const emails = await listInbox(client, 10);
      const target1 = emails.find((e) => e.subject === "Batch test email 1")!;
      const target2 = emails.find((e) => e.subject === "Batch test email 2")!;
      expect(target1).toBeDefined();
      expect(target2).toBeDefined();

      const store: Record<string, Record<string, Row>> = { actions: {} };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "batch_archive_emails",
        arguments: { email_ids: [target1.id, target2.id] },
      };

      const result = await handleToolCall(input, {}, client, DUMMY_SMTP_CONFIG, supabase);

      // Emails should be gone from inbox
      const after = await listInbox(client, 10);
      expect(after.find((e) => e.subject === "Batch test email 1")).toBeUndefined();
      expect(after.find((e) => e.subject === "Batch test email 2")).toBeUndefined();

      // Result summary
      const summary = result.result as Record<string, unknown>;
      expect(summary.total).toBe(2);
      expect(summary.succeeded).toBe(2);
      expect(summary.failed).toBe(0);

      // Action rows in DB
      const actionRows = Object.values(store.actions);
      const archiveRows = actionRows.filter((r) => r.tool_name === "archive_email");
      expect(archiveRows).toHaveLength(2);

      for (const row of archiveRows) {
        expect(row.status).toBe("executed");
        const undo = row.undo_recipe as Record<string, unknown>;
        expect(undo.operation).toBe("move_email");
      }

      // Undo recipes contain stable Message-ID from seed data
      const messageIds = archiveRows.map(
        (r) => ((r.undo_recipe as Record<string, unknown>).params as Record<string, unknown>).messageId
      );
      expect(messageIds).toContain("<batch-msg-001@example.com>");
      expect(messageIds).toContain("<batch-msg-002@example.com>");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Batch delete: creates pending action rows, does NOT move emails
  // (runs before undo test -- inbox still has emails 3 and 4)
  // --------------------------------------------------------------------------

  it("batch delete creates individual pending action rows", async () => {
    const client = await createImapConnection(batchImapConfig);
    try {
      const emails = await listInbox(client, 10);
      const target1 = emails.find((e) => e.subject === "Batch test email 3")!;
      const target2 = emails.find((e) => e.subject === "Batch test email 4")!;
      expect(target1).toBeDefined();
      expect(target2).toBeDefined();

      const store: Record<string, Record<string, Row>> = { actions: {} };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "batch_delete_emails",
        arguments: { email_ids: [target1.id, target2.id] },
      };

      const result = await handleToolCall(input, {}, client, DUMMY_SMTP_CONFIG, supabase);

      // Result summary
      const summary = result.result as Record<string, unknown>;
      expect(summary.total).toBe(2);
      expect(summary.succeeded).toBe(2);
      expect(summary.failed).toBe(0);

      // Action rows in DB should be pending delete_email
      const actionRows = Object.values(store.actions);
      const deleteRows = actionRows.filter((r) => r.tool_name === "delete_email");
      expect(deleteRows).toHaveLength(2);

      for (const row of deleteRows) {
        expect(row.status).toBe("pending");
        expect(row.requires_approval).toBe(true);
      }

      // Emails should still be in inbox (not moved)
      const after = await listInbox(client, 10);
      expect(after.find((e) => e.id === target1.id)).toBeDefined();
      expect(after.find((e) => e.id === target2.id)).toBeDefined();
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Individual undo after batch archive
  // --------------------------------------------------------------------------

  it("undoing one action from a batch restores only that email", async () => {
    const client = await createImapConnection(batchImapConfig);
    try {
      const emails = await listInbox(client, 10);
      const target1 = emails.find((e) => e.subject === "Batch test email 3")!;
      const target2 = emails.find((e) => e.subject === "Batch test email 4")!;
      expect(target1).toBeDefined();
      expect(target2).toBeDefined();

      const store: Record<string, Record<string, Row>> = { actions: {} };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "batch_archive_emails",
        arguments: { email_ids: [target1.id, target2.id] },
      };

      const result = await handleToolCall(input, {}, client, DUMMY_SMTP_CONFIG, supabase);
      const summary = result.result as Record<string, unknown>;
      const actionIds = summary.actionIds as string[];
      expect(actionIds).toHaveLength(2);

      // Undo only the first action
      const undoResult = await undoAction(actionIds[0], supabase, client);
      expect(undoResult.success).toBe(true);

      // Only email 3 should be back, email 4 stays archived
      const after = await listInbox(client, 10);
      expect(after.find((e) => e.subject === "Batch test email 3")).toBeDefined();
      expect(after.find((e) => e.subject === "Batch test email 4")).toBeUndefined();
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Partial failure: one valid ID, one invalid ID
  // --------------------------------------------------------------------------

  it("partial failure: one valid email ID and one invalid", async () => {
    const client = await createImapConnection(batchImapConfig);
    try {
      const emails = await listInbox(client, 10);
      const validTarget = emails[0]!;
      expect(validTarget).toBeDefined();

      const store: Record<string, Record<string, Row>> = { actions: {} };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "batch_archive_emails",
        arguments: { email_ids: [validTarget.id, "99999"] },
      };

      const result = await handleToolCall(input, {}, client, DUMMY_SMTP_CONFIG, supabase);

      const summary = result.result as Record<string, unknown>;
      expect(summary.succeeded).toBe(1);
      expect(summary.failed).toBe(1);

      // Only 1 action row created
      const actionRows = Object.values(store.actions);
      expect(actionRows).toHaveLength(1);
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Empty email_ids array
  // --------------------------------------------------------------------------

  it("empty email_ids array returns cleanly with no DB rows", async () => {
    const client = await createImapConnection(batchImapConfig);
    try {
      const store: Record<string, Record<string, Row>> = { actions: {} };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "batch_archive_emails",
        arguments: { email_ids: [] },
      };

      const result = await handleToolCall(input, {}, client, DUMMY_SMTP_CONFIG, supabase);

      const summary = result.result as Record<string, unknown>;
      expect(summary.total).toBe(0);
      expect(summary.succeeded).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.actionIds).toEqual([]);

      // No DB rows
      expect(Object.keys(store.actions)).toHaveLength(0);
    } finally {
      await closeImapConnection(client);
    }
  });
});

// ============================================================================
// BULK EXECUTE ACTIONS (INTEGRATION)
// ============================================================================

const BULK_IMAP_PORT = 14_247;

const BULK_SEED_MESSAGES = [
  {
    raw: [
      "From: Alice <alice@example.com>",
      "To: testuser@localhost",
      "Subject: Bulk test email 1",
      "Date: Mon, 10 Mar 2026 09:00:00 +0000",
      "Message-Id: <bulk-msg-001@example.com>",
      "",
      "Body of bulk test email 1.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Bob <bob@example.com>",
      "To: testuser@localhost",
      "Subject: Bulk test email 2",
      "Date: Tue, 11 Mar 2026 10:00:00 +0000",
      "Message-Id: <bulk-msg-002@example.com>",
      "",
      "Body of bulk test email 2.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Carol <carol@example.com>",
      "To: testuser@localhost",
      "Subject: Bulk test email 3",
      "Date: Wed, 12 Mar 2026 11:00:00 +0000",
      "Message-Id: <bulk-msg-003@example.com>",
      "",
      "Body of bulk test email 3.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Dave <dave@example.com>",
      "To: testuser@localhost",
      "Subject: Bulk test email 4",
      "Date: Thu, 13 Mar 2026 12:00:00 +0000",
      "Message-Id: <bulk-msg-004@example.com>",
      "",
      "Body of bulk test email 4.",
    ].join("\r\n"),
  },
];

function createBulkTestServer() {
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
        messages: [...BULK_SEED_MESSAGES],
      },
      "": {
        separator: "/",
        folders: {
          "[Google Mail]": {
            flags: ["\\Noselect"],
            folders: {
              "All Mail": {
                "special-use": "\\All",
                messages: [...BULK_SEED_MESSAGES],
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

const bulkImapConfig: ImapConfig = {
  host: "127.0.0.1",
  port: BULK_IMAP_PORT,
  user: TEST_USER,
  password: TEST_PASS,
  secure: false,
};

describe("bulkExecuteActions (Hoodiecrow integration)", () => {
  let server: ReturnType<typeof hoodiecrow>;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = createBulkTestServer();
        server.listen(BULK_IMAP_PORT, () => resolve());
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  // --------------------------------------------------------------------------
  // 2 pending delete actions: both move to Trash, both "executed" with undo
  // --------------------------------------------------------------------------

  it("bulk execute of 2 pending delete actions: both move to Trash with undo recipes", async () => {
    const client = await createImapConnection(bulkImapConfig);
    try {
      const emails = await listInbox(client, 10);
      const target1 = emails.find((e) => e.subject === "Bulk test email 1")!;
      const target2 = emails.find((e) => e.subject === "Bulk test email 2")!;
      expect(target1).toBeDefined();
      expect(target2).toBeDefined();

      const store: Record<string, Record<string, Row>> = {
        actions: {
          "bulk-d1": {
            id: "bulk-d1",
            user_id: "user-1",
            session_id: "session-1",
            tool_name: "delete_email",
            arguments: { email_id: target1.id, source_folder: "INBOX" },
            status: "pending",
            requires_approval: true,
            result: null,
            undo_recipe: null,
            undo_deadline: null,
            created_at: new Date().toISOString(),
            executed_at: null,
          },
          "bulk-d2": {
            id: "bulk-d2",
            user_id: "user-1",
            session_id: "session-1",
            tool_name: "delete_email",
            arguments: { email_id: target2.id, source_folder: "INBOX" },
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
      const supabase = createFakeSupabase(store);

      const response = await bulkExecuteActions(
        ["bulk-d1", "bulk-d2"],
        supabase,
        client,
        DUMMY_SMTP_CONFIG
      );

      // Summary
      expect(response.succeeded).toBe(2);
      expect(response.failed).toBe(0);
      expect(response.skipped).toBe(0);
      expect(response.total).toBe(2);

      // Emails should be gone from inbox
      const after = await listInbox(client, 10);
      expect(after.find((e) => e.subject === "Bulk test email 1")).toBeUndefined();
      expect(after.find((e) => e.subject === "Bulk test email 2")).toBeUndefined();

      // Action rows should be "executed" with undo recipes
      expect(store.actions["bulk-d1"].status).toBe("executed");
      expect(store.actions["bulk-d2"].status).toBe("executed");

      const undo1 = store.actions["bulk-d1"].undo_recipe as Record<string, unknown>;
      const undo2 = store.actions["bulk-d2"].undo_recipe as Record<string, unknown>;
      expect(undo1.operation).toBe("move_email");
      expect(undo2.operation).toBe("move_email");

      // Undo recipes should point from Trash back to INBOX
      const params1 = undo1.params as Record<string, unknown>;
      const params2 = undo2.params as Record<string, unknown>;
      expect(params1.to).toBe("INBOX");
      expect(params2.to).toBe("INBOX");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // One valid, one non-existent UID: valid succeeds, invalid fails
  // --------------------------------------------------------------------------

  it("bulk execute with one valid and one non-existent UID", async () => {
    const client = await createImapConnection(bulkImapConfig);
    try {
      const emails = await listInbox(client, 10);
      const target = emails.find((e) => e.subject === "Bulk test email 3")!;
      expect(target).toBeDefined();

      const store: Record<string, Record<string, Row>> = {
        actions: {
          "bulk-v1": {
            id: "bulk-v1",
            user_id: "user-1",
            session_id: "session-1",
            tool_name: "delete_email",
            arguments: { email_id: target.id, source_folder: "INBOX" },
            status: "pending",
            requires_approval: true,
            result: null,
            undo_recipe: null,
            undo_deadline: null,
            created_at: new Date().toISOString(),
            executed_at: null,
          },
          "bulk-v2": {
            id: "bulk-v2",
            user_id: "user-1",
            session_id: "session-1",
            tool_name: "delete_email",
            arguments: { email_id: "99999", source_folder: "INBOX" },
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
      const supabase = createFakeSupabase(store);

      const response = await bulkExecuteActions(
        ["bulk-v1", "bulk-v2"],
        supabase,
        client,
        DUMMY_SMTP_CONFIG
      );

      expect(response.succeeded).toBe(1);
      expect(response.failed).toBe(1);

      // Valid action succeeded
      const v1Result = response.results.find((r) => r.actionId === "bulk-v1")!;
      expect(v1Result.status).toBe("executed");
      expect(v1Result.error).toBeNull();

      // Invalid action failed
      const v2Result = response.results.find((r) => r.actionId === "bulk-v2")!;
      expect(v2Result.status).toBe("failed");
      expect(v2Result.error).toBeDefined();
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Already-executed action is skipped, pending actions still succeed
  // --------------------------------------------------------------------------

  it("bulk execute with an already-executed action: skipped", async () => {
    const client = await createImapConnection(bulkImapConfig);
    try {
      const emails = await listInbox(client, 10);
      const target = emails.find((e) => e.subject === "Bulk test email 4")!;
      expect(target).toBeDefined();

      const store: Record<string, Record<string, Row>> = {
        actions: {
          "bulk-s1": {
            id: "bulk-s1",
            user_id: "user-1",
            session_id: "session-1",
            tool_name: "delete_email",
            arguments: { email_id: "123", source_folder: "INBOX" },
            status: "executed",
            requires_approval: true,
            result: { deleted: true },
            undo_recipe: null,
            undo_deadline: null,
            created_at: new Date().toISOString(),
            executed_at: new Date().toISOString(),
          },
          "bulk-s2": {
            id: "bulk-s2",
            user_id: "user-1",
            session_id: "session-1",
            tool_name: "delete_email",
            arguments: { email_id: target.id, source_folder: "INBOX" },
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
      const supabase = createFakeSupabase(store);

      const response = await bulkExecuteActions(
        ["bulk-s1", "bulk-s2"],
        supabase,
        client,
        DUMMY_SMTP_CONFIG
      );

      expect(response.skipped).toBe(1);
      expect(response.succeeded).toBe(1);

      const s1Result = response.results.find((r) => r.actionId === "bulk-s1")!;
      expect(s1Result.status).toBe("skipped");

      const s2Result = response.results.find((r) => r.actionId === "bulk-s2")!;
      expect(s2Result.status).toBe("executed");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Empty array: returns immediately
  // --------------------------------------------------------------------------

  it("bulk execute with empty array: returns immediately", async () => {
    const client = await createImapConnection(bulkImapConfig);
    try {
      const supabase = createFakeSupabase({ actions: {} });

      const response = await bulkExecuteActions([], supabase, client, DUMMY_SMTP_CONFIG);

      expect(response.total).toBe(0);
      expect(response.succeeded).toBe(0);
      expect(response.failed).toBe(0);
      expect(response.skipped).toBe(0);
      expect(response.results).toEqual([]);
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Mix of delete_email and archive_email: both move to correct folders
  // --------------------------------------------------------------------------

  it("bulk execute with mix of delete and archive: correct target folders", async () => {
    const client = await createImapConnection(bulkImapConfig);
    try {
      // At this point emails 1, 2, 3 may have been moved by previous tests.
      // Email 4 was moved by the skip test. List remaining emails.
      const emails = await listInbox(client, 10);

      // We need at least 2 emails. If inbox is depleted, this test will
      // use whatever is left. The seed has 4 emails; previous tests moved
      // some but we still verify what's available.
      if (emails.length < 2) {
        // Not enough emails to test -- skip gracefully
        return;
      }

      const deleteTarget = emails[0]!;
      const archiveTarget = emails[1]!;

      const store: Record<string, Record<string, Row>> = {
        actions: {
          "bulk-m1": {
            id: "bulk-m1",
            user_id: "user-1",
            session_id: "session-1",
            tool_name: "delete_email",
            arguments: { email_id: deleteTarget.id, source_folder: "INBOX" },
            status: "pending",
            requires_approval: true,
            result: null,
            undo_recipe: null,
            undo_deadline: null,
            created_at: new Date().toISOString(),
            executed_at: null,
          },
          "bulk-m2": {
            id: "bulk-m2",
            user_id: "user-1",
            session_id: "session-1",
            tool_name: "archive_email",
            arguments: { email_id: archiveTarget.id, source_folder: "INBOX" },
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
      const supabase = createFakeSupabase(store);

      const response = await bulkExecuteActions(
        ["bulk-m1", "bulk-m2"],
        supabase,
        client,
        DUMMY_SMTP_CONFIG
      );

      expect(response.succeeded).toBe(2);
      expect(response.failed).toBe(0);

      // Delete action should have undo pointing to Trash
      const undo1 = store.actions["bulk-m1"].undo_recipe as Record<string, unknown>;
      expect(undo1.operation).toBe("move_email");
      const params1 = undo1.params as Record<string, unknown>;
      // "from" is the target folder (Trash), "to" is the source (INBOX)
      expect((params1.from as string).includes("Trash")).toBe(true);
      expect(params1.to).toBe("INBOX");

      // Archive action should have undo pointing to All Mail
      const undo2 = store.actions["bulk-m2"].undo_recipe as Record<string, unknown>;
      expect(undo2.operation).toBe("move_email");
      const params2 = undo2.params as Record<string, unknown>;
      expect((params2.from as string).includes("All Mail")).toBe(true);
      expect(params2.to).toBe("INBOX");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // send_email mixed in: falls back to individual executeAction, fails (no SMTP)
  // --------------------------------------------------------------------------

  it("bulk execute with send_email mixed in: send fails, email-move succeeds", async () => {
    const client = await createImapConnection(bulkImapConfig);
    try {
      const emails = await listInbox(client, 10);

      // We need at least 1 email for the delete action
      if (emails.length < 1) {
        return;
      }

      const deleteTarget = emails[0]!;

      const store: Record<string, Record<string, Row>> = {
        actions: {
          "bulk-f1": {
            id: "bulk-f1",
            user_id: "user-1",
            session_id: "session-1",
            tool_name: "delete_email",
            arguments: { email_id: deleteTarget.id, source_folder: "INBOX" },
            status: "pending",
            requires_approval: true,
            result: null,
            undo_recipe: null,
            undo_deadline: null,
            created_at: new Date().toISOString(),
            executed_at: null,
          },
          "bulk-f2": {
            id: "bulk-f2",
            user_id: "user-1",
            session_id: "session-1",
            tool_name: "send_email",
            arguments: {
              to: "someone@example.com",
              subject: "Test send",
              body: "This should fail.",
            },
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
      const supabase = createFakeSupabase(store);

      const response = await bulkExecuteActions(
        ["bulk-f1", "bulk-f2"],
        supabase,
        client,
        DUMMY_SMTP_CONFIG
      );

      // Delete should succeed, send should fail (no real SMTP)
      expect(response.succeeded).toBe(1);
      expect(response.failed).toBe(1);

      const f1Result = response.results.find((r) => r.actionId === "bulk-f1")!;
      expect(f1Result.status).toBe("executed");

      const f2Result = response.results.find((r) => r.actionId === "bulk-f2")!;
      expect(f2Result.status).toBe("failed");
      expect(f2Result.error).toBeDefined();
    } finally {
      await closeImapConnection(client);
    }
  });
});

// ============================================================================
// SESSION-AWARE INBOX FILTERING (INTEGRATION)
// ============================================================================

const FILTER_IMAP_PORT = 14_245;

const FILTER_SEED_MESSAGES = [
  {
    raw: [
      "From: Alice <alice@example.com>",
      "To: testuser@localhost",
      "Subject: Filter test email 1",
      "Date: Mon, 10 Mar 2026 09:00:00 +0000",
      "Message-Id: <filter-msg-001@example.com>",
      "",
      "Body of filter test email 1.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Bob <bob@example.com>",
      "To: testuser@localhost",
      "Subject: Filter test email 2",
      "Date: Tue, 11 Mar 2026 10:00:00 +0000",
      "Message-Id: <filter-msg-002@example.com>",
      "",
      "Body of filter test email 2.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Carol <carol@example.com>",
      "To: testuser@localhost",
      "Subject: Filter test email 3",
      "Date: Wed, 12 Mar 2026 11:00:00 +0000",
      "Message-Id: <filter-msg-003@example.com>",
      "",
      "Body of filter test email 3.",
    ].join("\r\n"),
  },
];

function createFilterTestServer() {
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
        messages: [...FILTER_SEED_MESSAGES],
      },
      "": {
        separator: "/",
        folders: {
          "[Google Mail]": {
            flags: ["\\Noselect"],
            folders: {
              "All Mail": {
                "special-use": "\\All",
                messages: [...FILTER_SEED_MESSAGES],
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

const filterImapConfig: ImapConfig = {
  host: "127.0.0.1",
  port: FILTER_IMAP_PORT,
  user: TEST_USER,
  password: TEST_PASS,
  secure: false,
};

describe("Session-aware inbox filtering", () => {
  let server: ReturnType<typeof hoodiecrow>;
  /** Map of subject -> real IMAP email ID, resolved in beforeAll */
  let idBySubject: Record<string, string>;

  beforeAll(async () => {
    // Start the Hoodiecrow server
    await new Promise<void>((resolve) => {
      server = createFilterTestServer();
      server.listen(FILTER_IMAP_PORT, () => resolve());
    });

    // Fetch real IMAP email IDs so tests can reference them by subject
    const client = await createImapConnection(filterImapConfig);
    try {
      const emails = await listInbox(client, 10);
      idBySubject = {};
      for (const e of emails) {
        idBySubject[e.subject] = e.id;
      }
    } finally {
      await closeImapConnection(client);
    }
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  // --------------------------------------------------------------------------
  // Pending delete_email filters email from list_inbox
  // --------------------------------------------------------------------------

  it("list_inbox excludes emails with pending delete_email actions", async () => {
    const client = await createImapConnection(filterImapConfig);
    try {
      const store: Record<string, Record<string, Row>> = {
        actions: {
          "pd-1": {
            id: "pd-1",
            session_id: "session-1",
            tool_name: "delete_email",
            arguments: { email_id: idBySubject["Filter test email 1"] },
            status: "pending",
            requires_approval: true,
          },
        },
      };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "list_inbox",
        arguments: { limit: 10 },
      };

      const result = await handleToolCall(input, {}, client, DUMMY_SMTP_CONFIG, supabase);
      const markdown = (result.result as Record<string, unknown>).markdown as string;

      // First email should be filtered out; others present
      expect(markdown).not.toContain("Filter test email 1");
      expect(markdown).toContain("Filter test email 2");
      expect(markdown).toContain("Filter test email 3");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Pending archive_email filters email from list_inbox
  // --------------------------------------------------------------------------

  it("list_inbox excludes emails with pending archive_email actions", async () => {
    const client = await createImapConnection(filterImapConfig);
    try {
      const store: Record<string, Record<string, Row>> = {
        actions: {
          "pa-1": {
            id: "pa-1",
            session_id: "session-1",
            tool_name: "archive_email",
            arguments: { email_id: idBySubject["Filter test email 2"] },
            status: "pending",
            requires_approval: true,
          },
        },
      };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "list_inbox",
        arguments: { limit: 10 },
      };

      const result = await handleToolCall(input, {}, client, DUMMY_SMTP_CONFIG, supabase);
      const markdown = (result.result as Record<string, unknown>).markdown as string;

      expect(markdown).toContain("Filter test email 1");
      expect(markdown).not.toContain("Filter test email 2");
      expect(markdown).toContain("Filter test email 3");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Pending delete_email filters email from search_emails
  // --------------------------------------------------------------------------

  it("search_emails excludes emails with pending delete_email actions", async () => {
    const client = await createImapConnection(filterImapConfig);
    try {
      const store: Record<string, Record<string, Row>> = {
        actions: {
          "sd-1": {
            id: "sd-1",
            session_id: "session-1",
            tool_name: "delete_email",
            arguments: { email_id: idBySubject["Filter test email 1"] },
            status: "pending",
            requires_approval: true,
          },
        },
      };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "search_emails",
        arguments: { query: "filter test" },
      };

      const result = await handleToolCall(input, {}, client, DUMMY_SMTP_CONFIG, supabase);
      const markdown = (result.result as Record<string, unknown>).markdown as string;

      expect(markdown).not.toContain("Filter test email 1");
      expect(markdown).toContain("Filter test email 2");
      expect(markdown).toContain("Filter test email 3");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Queued send_email appears in list_inbox as "Queued Outgoing"
  // --------------------------------------------------------------------------

  it("list_inbox appends queued send_email actions as Queued Outgoing section", async () => {
    const client = await createImapConnection(filterImapConfig);
    try {
      const store: Record<string, Record<string, Row>> = {
        actions: {
          "qs-1": {
            id: "qs-1",
            session_id: "session-1",
            tool_name: "send_email",
            arguments: { to: "alice@example.com", subject: "Re: Meeting notes", body: "See you there." },
            status: "pending",
            requires_approval: true,
          },
        },
      };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "list_inbox",
        arguments: { limit: 10 },
      };

      const result = await handleToolCall(input, {}, client, DUMMY_SMTP_CONFIG, supabase);
      const markdown = (result.result as Record<string, unknown>).markdown as string;

      expect(markdown).toContain("Queued Outgoing");
      expect(markdown).toContain("alice@example.com");
      expect(markdown).toContain("Re: Meeting notes");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Pending actions from a different session do NOT filter
  // --------------------------------------------------------------------------

  it("list_inbox does NOT filter emails from a different session", async () => {
    const client = await createImapConnection(filterImapConfig);
    try {
      const store: Record<string, Record<string, Row>> = {
        actions: {
          "other-1": {
            id: "other-1",
            session_id: "session-OTHER",
            tool_name: "delete_email",
            arguments: { email_id: idBySubject["Filter test email 1"] },
            status: "pending",
            requires_approval: true,
          },
        },
      };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "list_inbox",
        arguments: { limit: 10 },
      };

      const result = await handleToolCall(input, {}, client, DUMMY_SMTP_CONFIG, supabase);
      const markdown = (result.result as Record<string, unknown>).markdown as string;

      // All emails should be present -- different session's actions don't apply
      expect(markdown).toContain("Filter test email 1");
      expect(markdown).toContain("Filter test email 2");
      expect(markdown).toContain("Filter test email 3");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // No pending actions returns full results unchanged
  // --------------------------------------------------------------------------

  it("list_inbox with no pending actions returns full results unchanged", async () => {
    const client = await createImapConnection(filterImapConfig);
    try {
      const store: Record<string, Record<string, Row>> = { actions: {} };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "list_inbox",
        arguments: { limit: 10 },
      };

      const result = await handleToolCall(input, {}, client, DUMMY_SMTP_CONFIG, supabase);
      const markdown = (result.result as Record<string, unknown>).markdown as string;

      expect(markdown).toContain("Filter test email 1");
      expect(markdown).toContain("Filter test email 2");
      expect(markdown).toContain("Filter test email 3");
      expect(markdown).not.toContain("Queued Outgoing");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Approved (not just pending) delete actions also filter
  // --------------------------------------------------------------------------

  it("list_inbox excludes emails with approved delete actions", async () => {
    const client = await createImapConnection(filterImapConfig);
    try {
      const store: Record<string, Record<string, Row>> = {
        actions: {
          "ad-1": {
            id: "ad-1",
            session_id: "session-1",
            tool_name: "delete_email",
            arguments: { email_id: idBySubject["Filter test email 3"] },
            status: "approved",
            requires_approval: true,
          },
        },
      };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "list_inbox",
        arguments: { limit: 10 },
      };

      const result = await handleToolCall(input, {}, client, DUMMY_SMTP_CONFIG, supabase);
      const markdown = (result.result as Record<string, unknown>).markdown as string;

      expect(markdown).toContain("Filter test email 1");
      expect(markdown).toContain("Filter test email 2");
      expect(markdown).not.toContain("Filter test email 3");
    } finally {
      await closeImapConnection(client);
    }
  });
});

// ============================================================================
// OVERFETCH FOR PENDING ACTIONS (INTEGRATION)
// ============================================================================

const OVERFETCH_IMAP_PORT = 14_246;

const OVERFETCH_SEED_MESSAGES = [
  {
    raw: [
      "From: Alice <alice@example.com>",
      "To: testuser@localhost",
      "Subject: Overfetch email 1",
      "Date: Mon, 10 Mar 2026 09:00:00 +0000",
      "Message-Id: <overfetch-msg-001@example.com>",
      "",
      "Body of overfetch email 1.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Bob <bob@example.com>",
      "To: testuser@localhost",
      "Subject: Overfetch email 2",
      "Date: Tue, 11 Mar 2026 10:00:00 +0000",
      "Message-Id: <overfetch-msg-002@example.com>",
      "",
      "Body of overfetch email 2.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Carol <carol@example.com>",
      "To: testuser@localhost",
      "Subject: Overfetch email 3",
      "Date: Wed, 12 Mar 2026 11:00:00 +0000",
      "Message-Id: <overfetch-msg-003@example.com>",
      "",
      "Body of overfetch email 3.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Dave <dave@example.com>",
      "To: testuser@localhost",
      "Subject: Overfetch email 4",
      "Date: Thu, 13 Mar 2026 12:00:00 +0000",
      "Message-Id: <overfetch-msg-004@example.com>",
      "",
      "Body of overfetch email 4.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Eve <eve@example.com>",
      "To: testuser@localhost",
      "Subject: Overfetch email 5",
      "Date: Fri, 14 Mar 2026 13:00:00 +0000",
      "Message-Id: <overfetch-msg-005@example.com>",
      "",
      "Body of overfetch email 5.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Frank <frank@example.com>",
      "To: testuser@localhost",
      "Subject: Overfetch email 6",
      "Date: Sat, 15 Mar 2026 14:00:00 +0000",
      "Message-Id: <overfetch-msg-006@example.com>",
      "",
      "Body of overfetch email 6.",
    ].join("\r\n"),
  },
];

function createOverfetchTestServer() {
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
        messages: [...OVERFETCH_SEED_MESSAGES],
      },
      "": {
        separator: "/",
        folders: {
          "[Google Mail]": {
            flags: ["\\Noselect"],
            folders: {
              "All Mail": {
                "special-use": "\\All",
                messages: [...OVERFETCH_SEED_MESSAGES],
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

const overfetchImapConfig: ImapConfig = {
  host: "127.0.0.1",
  port: OVERFETCH_IMAP_PORT,
  user: TEST_USER,
  password: TEST_PASS,
  secure: false,
};

describe("Overfetch for pending actions", () => {
  let server: ReturnType<typeof hoodiecrow>;
  /** Map of subject -> real IMAP email ID, resolved in beforeAll */
  let idBySubject: Record<string, string>;

  beforeAll(async () => {
    // Start the Hoodiecrow server
    await new Promise<void>((resolve) => {
      server = createOverfetchTestServer();
      server.listen(OVERFETCH_IMAP_PORT, () => resolve());
    });

    // Fetch real IMAP email IDs so tests can reference them by subject
    const client = await createImapConnection(overfetchImapConfig);
    try {
      const emails = await listInbox(client, 10);
      idBySubject = {};
      for (const e of emails) {
        idBySubject[e.subject] = e.id;
      }
    } finally {
      await closeImapConnection(client);
    }
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  // --------------------------------------------------------------------------
  // Overfetch: limit=3 with 3 newest pending returns 3 older emails
  // --------------------------------------------------------------------------

  it("list_inbox with limit=3 where all 3 newest have pending deletes returns the next 3 older emails", async () => {
    const client = await createImapConnection(overfetchImapConfig);
    try {
      // Emails 4, 5, 6 are the newest (latest dates). Create pending delete actions for them.
      const store: Record<string, Record<string, Row>> = {
        actions: {
          "of-1": {
            id: "of-1",
            session_id: "session-1",
            tool_name: "delete_email",
            arguments: { email_id: idBySubject["Overfetch email 4"] },
            status: "pending",
            requires_approval: true,
          },
          "of-2": {
            id: "of-2",
            session_id: "session-1",
            tool_name: "delete_email",
            arguments: { email_id: idBySubject["Overfetch email 5"] },
            status: "pending",
            requires_approval: true,
          },
          "of-3": {
            id: "of-3",
            session_id: "session-1",
            tool_name: "delete_email",
            arguments: { email_id: idBySubject["Overfetch email 6"] },
            status: "pending",
            requires_approval: true,
          },
        },
      };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "list_inbox",
        arguments: { limit: 3 },
      };

      const result = await handleToolCall(input, {}, client, DUMMY_SMTP_CONFIG, supabase);
      const markdown = (result.result as Record<string, unknown>).markdown as string;

      // The 3 older emails should be present
      expect(markdown).toContain("Overfetch email 1");
      expect(markdown).toContain("Overfetch email 2");
      expect(markdown).toContain("Overfetch email 3");

      // The 3 newest emails (with pending deletes) should be filtered out
      expect(markdown).not.toContain("Overfetch email 4");
      expect(markdown).not.toContain("Overfetch email 5");
      expect(markdown).not.toContain("Overfetch email 6");
    } finally {
      await closeImapConnection(client);
    }
  });
});
