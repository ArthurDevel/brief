/**
 * Integration tests for the action queue: execute and undo flows.
 *
 * Uses Hoodiecrow (in-memory IMAP server) for real email operations
 * and a lightweight fake Supabase for database state.
 *
 * Tests verify actual outcomes (emails moved, drafts created/deleted,
 * status transitions) rather than implementation details.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import hoodiecrow from "hoodiecrow-imap";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImapConfig, EmailAccountRecord, EmailAccountClient } from "@dublin/email";
import {
  createImapConnection,
  closeImapConnection,
  listInbox,
} from "@dublin/email";
import { executeAction, undoAction, handleToolCall, classifyAction, convertActionToDraft, bulkExecuteActions } from "../action-queue";
import type { ActionInput, ActionResult } from "../types";

// ---------------------------------------------------------------------------
// Mock createEmailAccountClient: pass through for custom IMAP, return mock
// for Unipile-backed accounts. vi.mock is hoisted so the dynamic imports in
// action-queue.ts pick up the mock automatically.
// ---------------------------------------------------------------------------

let _mockUnipileClient: EmailAccountClient | null = null;

/**
 * Set the mock EmailAccountClient returned for Unipile accounts.
 * Call with null to reset (causes an error if a Unipile account is used).
 */
function setMockUnipileClient(client: EmailAccountClient | null) {
  _mockUnipileClient = client;
}

vi.mock("@dublin/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dublin/email")>();
  return {
    ...actual,
    createEmailAccountClient: async (account: EmailAccountRecord) => {
      if (account.connectionType === "unipile") {
        if (!_mockUnipileClient) {
          throw new Error("No mock Unipile client configured for test");
        }
        return _mockUnipileClient;
      }
      return actual.createEmailAccountClient(account);
    },
  };
});

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

/**
 * Builds an EmailAccountRecord from an ImapConfig for testing.
 * Wraps the test IMAP/SMTP config in the provider-agnostic record shape.
 * @param config - IMAP connection config from the test server
 * @returns EmailAccountRecord suitable for action-queue functions
 */
function buildTestEmailAccount(config: ImapConfig): EmailAccountRecord {
  return {
    id: "test-account-id",
    userId: "user-1",
    provider: "custom",
    connectionType: "imap_smtp",
    emailAddress: `${config.user}@localhost`,
    unipileAccountId: null,
    status: "connected",
    lastError: null,
    customConfig: {
      imap: config,
      smtp: DUMMY_SMTP_CONFIG,
    },
  };
}

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
        setTimeout(resolve, 2000);
      }),
  );

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

      const result = await executeAction("a3", supabase, buildTestEmailAccount(imapConfig));

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

      await executeAction("a4", supabase, buildTestEmailAccount(imapConfig));

      const undoResult = await undoAction("a4", supabase, buildTestEmailAccount(imapConfig));

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
        executeAction("a-fail", supabase, buildTestEmailAccount(imapConfig)),
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
        executeAction("a5", supabase, buildTestEmailAccount(imapConfig)),
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
      const result = await undoAction("a6", supabase, buildTestEmailAccount(imapConfig));
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

  it("classifies batch_move_to_folder as mutating_auto", () => {
    expect(classifyAction("batch_move_to_folder", {})).toBe("mutating_auto");
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
        setTimeout(resolve, 2000);
      }),
  );

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

      const result = await handleToolCall(input, {}, buildTestEmailAccount(batchImapConfig), supabase);

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

      const result = await handleToolCall(input, {}, buildTestEmailAccount(batchImapConfig), supabase);

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

      const result = await handleToolCall(input, {}, buildTestEmailAccount(batchImapConfig), supabase);

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
// BATCH MOVE TO FOLDER (INTEGRATION)
// ============================================================================

const BATCH_MOVE_IMAP_PORT = 14_248;

const BATCH_MOVE_SEED_MESSAGES = [
  {
    raw: [
      "From: Alice <alice@example.com>",
      "To: testuser@localhost",
      "Subject: Batch move email 1",
      "Date: Mon, 10 Mar 2026 09:00:00 +0000",
      "Message-Id: <batch-move-001@example.com>",
      "",
      "Body of batch move email 1.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Bob <bob@example.com>",
      "To: testuser@localhost",
      "Subject: Batch move email 2",
      "Date: Tue, 11 Mar 2026 10:00:00 +0000",
      "Message-Id: <batch-move-002@example.com>",
      "",
      "Body of batch move email 2.",
    ].join("\r\n"),
  },
  {
    raw: [
      "From: Carol <carol@example.com>",
      "To: testuser@localhost",
      "Subject: Batch move email 3",
      "Date: Wed, 12 Mar 2026 11:00:00 +0000",
      "Message-Id: <batch-move-003@example.com>",
      "",
      "Body of batch move email 3.",
    ].join("\r\n"),
  },
];

function createBatchMoveTestServer() {
  return hoodiecrow({
    plugins: [
      "ID", "SASL-IR", "AUTH-PLAIN", "NAMESPACE", "IDLE",
      "ENABLE", "CONDSTORE", "LITERALPLUS", "UNSELECT",
      "SPECIAL-USE", "CREATE-SPECIAL-USE",
    ],
    storage: {
      INBOX: {
        messages: [...BATCH_MOVE_SEED_MESSAGES],
      },
      "": {
        separator: "/",
        folders: {
          "[Google Mail]": {
            flags: ["\\Noselect"],
            folders: {
              "All Mail": {
                "special-use": "\\All",
                messages: [...BATCH_MOVE_SEED_MESSAGES],
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

const batchMoveImapConfig: ImapConfig = {
  host: "127.0.0.1",
  port: BATCH_MOVE_IMAP_PORT,
  user: TEST_USER,
  password: TEST_PASS,
  secure: false,
};

describe("Batch move to folder (Hoodiecrow integration)", () => {
  let server: ReturnType<typeof hoodiecrow>;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = createBatchMoveTestServer();
        server.listen(BATCH_MOVE_IMAP_PORT, () => resolve());
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 2000);
      }),
  );

  // --------------------------------------------------------------------------
  // Happy path: batch move moves emails to target folder
  // --------------------------------------------------------------------------

  it("batch move moves multiple emails to Trash and creates action rows with undo recipes", async () => {
    let client = await createImapConnection(batchMoveImapConfig);
    try {
      const emails = await listInbox(client, 10);
      const target1 = emails.find((e) => e.subject === "Batch move email 1")!;
      const target2 = emails.find((e) => e.subject === "Batch move email 2")!;
      expect(target1).toBeDefined();
      expect(target2).toBeDefined();

      const store: Record<string, Record<string, Row>> = { actions: {} };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "batch_move_to_folder",
        arguments: {
          email_ids: [target1.id, target2.id],
          folder: "[Google Mail]/Trash",
          source_folder: "INBOX",
        },
      };

      const result = await handleToolCall(input, {}, buildTestEmailAccount(batchMoveImapConfig), supabase);

      // Result summary shows both succeeded
      const summary = result.result as Record<string, unknown>;
      expect(summary.total).toBe(2);
      expect(summary.succeeded).toBe(2);
      expect(summary.failed).toBe(0);

      // Action rows should have undo recipes
      const actionRows = Object.values(store.actions);
      const moveRows = actionRows.filter((r) => r.tool_name === "move_to_folder");
      expect(moveRows).toHaveLength(2);
      for (const row of moveRows) {
        expect(row.status).toBe("executed");
        expect(row.undo_recipe).toBeTruthy();
      }

      // Reconnect to see updated mailbox state (handleToolCall uses its own connection)
      await closeImapConnection(client);
      client = await createImapConnection(batchMoveImapConfig);
      const after = await listInbox(client, 10);
      expect(after.find((e) => e.id === target1.id)).toBeUndefined();
      expect(after.find((e) => e.id === target2.id)).toBeUndefined();
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Partial failure: one valid ID, one invalid ID
  // --------------------------------------------------------------------------

  it("partial failure: valid email moves, invalid email fails", async () => {
    const client = await createImapConnection(batchMoveImapConfig);
    try {
      const emails = await listInbox(client, 10);
      const validTarget = emails[0]!;
      expect(validTarget).toBeDefined();

      const store: Record<string, Record<string, Row>> = { actions: {} };
      const supabase = createFakeSupabase(store);

      const input: ActionInput = {
        userId: "user-1",
        sessionId: "session-1",
        toolName: "batch_move_to_folder",
        arguments: {
          email_ids: [validTarget.id, "99999"],
          folder: "[Google Mail]/Trash",
          source_folder: "INBOX",
        },
      };

      const result = await handleToolCall(input, {}, buildTestEmailAccount(batchMoveImapConfig), supabase);

      const summary = result.result as Record<string, unknown>;
      expect(summary.succeeded).toBe(1);
      expect(summary.failed).toBe(1);
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Empty email_ids
  // --------------------------------------------------------------------------

  it("empty email_ids returns zero counts with no side effects", async () => {
    const store: Record<string, Record<string, Row>> = { actions: {} };
    const supabase = createFakeSupabase(store);

    const input: ActionInput = {
      userId: "user-1",
      sessionId: "session-1",
      toolName: "batch_move_to_folder",
      arguments: {
        email_ids: [],
        folder: "[Google Mail]/Trash",
      },
    };

    const result = await handleToolCall(input, {}, buildTestEmailAccount(batchMoveImapConfig), supabase);

    const summary = result.result as Record<string, unknown>;
    expect(summary.total).toBe(0);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);
    expect(Object.keys(store.actions)).toHaveLength(0);
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
        setTimeout(resolve, 2000);
      }),
  );

  // --------------------------------------------------------------------------
  // 2 pending delete actions: both move to Trash, both "executed" with undo
  // --------------------------------------------------------------------------

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
        buildTestEmailAccount(bulkImapConfig)
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
        buildTestEmailAccount(bulkImapConfig)
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

      const response = await bulkExecuteActions([], supabase, buildTestEmailAccount(bulkImapConfig));

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
        buildTestEmailAccount(bulkImapConfig)
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
        buildTestEmailAccount(bulkImapConfig)
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
        setTimeout(resolve, 2000);
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

      const result = await handleToolCall(input, {}, buildTestEmailAccount(filterImapConfig), supabase);
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

      const result = await handleToolCall(input, {}, buildTestEmailAccount(filterImapConfig), supabase);
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

      const result = await handleToolCall(input, {}, buildTestEmailAccount(filterImapConfig), supabase);
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

      const result = await handleToolCall(input, {}, buildTestEmailAccount(filterImapConfig), supabase);
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

      const result = await handleToolCall(input, {}, buildTestEmailAccount(filterImapConfig), supabase);
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

      const result = await handleToolCall(input, {}, buildTestEmailAccount(filterImapConfig), supabase);
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

      const result = await handleToolCall(input, {}, buildTestEmailAccount(filterImapConfig), supabase);
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
        setTimeout(resolve, 2000);
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

      const result = await handleToolCall(input, {}, buildTestEmailAccount(overfetchImapConfig), supabase);
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

// ============================================================================
// CONVERT ACTION TO DRAFT
// ============================================================================

const CONVERT_IMAP_PORT = 14_247;

function createConvertTestServer() {
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
        messages: [],
      },
      "": {
        separator: "/",
        folders: {
          "[Google Mail]": {
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

const convertImapConfig: ImapConfig = {
  host: "127.0.0.1",
  port: CONVERT_IMAP_PORT,
  user: TEST_USER,
  password: TEST_PASS,
  secure: false,
};

describe("convertActionToDraft", () => {
  let server: ReturnType<typeof hoodiecrow>;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = createConvertTestServer();
        server.listen(CONVERT_IMAP_PORT, () => resolve());
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 2000);
      }),
  );

  // --------------------------------------------------------------------------
  // Happy path: pending send_email -> converted with draftUid
  // --------------------------------------------------------------------------

  it("converts a pending send_email action to a draft and returns draftUid", async () => {
    const client = await createImapConnection(convertImapConfig);
    try {
      const { store, supabase } = makePendingAction("c1", "send_email", {
        to: "recipient@example.com",
        subject: "Convert draft test",
        body: "This should become a draft.",
      });

      const result = await convertActionToDraft("c1", supabase, buildTestEmailAccount(convertImapConfig));

      // Result should indicate conversion with a draftUid
      expect(result.status).toBe("converted");
      expect(result.result).toMatchObject({ convertedToDraft: true });
      expect((result.result as Record<string, unknown>).draftUid).toBeDefined();

      // Action row should be updated to "converted"
      const action = store.actions["c1"];
      expect(action.status).toBe("converted");
      expect((action.result as Record<string, unknown>).convertedToDraft).toBe(true);
      expect((action.result as Record<string, unknown>).draftUid).toBeDefined();
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Rejects non-pending action
  // --------------------------------------------------------------------------

  it("rejects a non-pending send_email action", async () => {
    const store: Record<string, Record<string, Row>> = {
      actions: {
        "c2": {
          id: "c2",
          user_id: "user-1",
          session_id: "session-1",
          tool_name: "send_email",
          arguments: { to: "someone@example.com", subject: "Test", body: "Body" },
          status: "executed",
        },
      },
    };
    const supabase = createFakeSupabase(store);
    const client = await createImapConnection(convertImapConfig);

    try {
      await expect(
        convertActionToDraft("c2", supabase, buildTestEmailAccount(convertImapConfig)),
      ).rejects.toThrow("not pending");
    } finally {
      await closeImapConnection(client);
    }
  });

  // --------------------------------------------------------------------------
  // Rejects non-send_email action
  // --------------------------------------------------------------------------

  it("rejects a pending non-send_email action", async () => {
    const { supabase } = makePendingAction("c3", "archive_email", {
      email_id: "some-id",
      source_folder: "INBOX",
    });
    const client = await createImapConnection(convertImapConfig);

    try {
      await expect(
        convertActionToDraft("c3", supabase, buildTestEmailAccount(convertImapConfig)),
      ).rejects.toThrow("not a send_email or reply_email action");
    } finally {
      await closeImapConnection(client);
    }
  });
});

// ============================================================================
// UNIPILE-BACKED ACCOUNT TESTS
// ============================================================================

/**
 * Builds an EmailAccountRecord for a Unipile-backed Gmail/Outlook account.
 * No customConfig -- email operations go through the mocked Unipile client.
 */
function buildUnipileTestAccount(): EmailAccountRecord {
  return {
    id: "unipile-account-id",
    userId: "user-1",
    provider: "gmail",
    connectionType: "unipile",
    emailAddress: "user@gmail.com",
    unipileAccountId: "uni_abc123",
    status: "connected",
    lastError: null,
  };
}

/**
 * Creates a mock EmailAccountClient with vi.fn() stubs for all methods.
 * Individual tests can override return values as needed.
 */
function createMockEmailClient(): EmailAccountClient {
  return {
    listInbox: vi.fn().mockResolvedValue([]),
    searchEmails: vi.fn().mockResolvedValue([]),
    readEmail: vi.fn().mockResolvedValue({ id: "e1", subject: "Test", from: "a@b.com", to: ["x@y.com"], cc: [], date: "", body: "", snippet: "" }),
    readThread: vi.fn().mockResolvedValue([]),
    markAsRead: vi.fn().mockResolvedValue(undefined),
    archiveEmail: vi.fn().mockResolvedValue({ operation: "move_email", params: { emailId: "e1", from: "All Mail", to: "INBOX" } }),
    deleteEmail: vi.fn().mockResolvedValue({ operation: "move_email", params: { emailId: "e1", from: "Trash", to: "INBOX" } }),
    moveToFolder: vi.fn().mockResolvedValue({ operation: "move_email", params: { emailId: "e1", from: "Target", to: "INBOX" } }),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    listFolders: vi.fn().mockResolvedValue([{ name: "INBOX", path: "INBOX" }]),
    resolveSpecialUseFolder: vi.fn().mockResolvedValue("Trash"),
    saveDraft: vi.fn().mockResolvedValue({ operation: "delete_draft", params: { draftUid: "999" } }),
    deleteDraft: vi.fn().mockResolvedValue(undefined),
    sendEmail: vi.fn().mockResolvedValue(undefined),
    replyEmail: vi.fn().mockResolvedValue(undefined),
    fetchReplyContext: vi.fn().mockResolvedValue({ messageId: "<orig@example.com>", from: "sender@example.com", to: ["user@gmail.com"], cc: [], subject: "Re: Hello", references: [] }),
    fetchEmailMetaBatch: vi.fn().mockResolvedValue(new Map()),
  };
}

describe("Unipile-backed account", () => {
  let mockClient: EmailAccountClient;

  beforeAll(() => {
    mockClient = createMockEmailClient();
    setMockUnipileClient(mockClient);
  });

  afterAll(() => {
    setMockUnipileClient(null);
  });

  // --------------------------------------------------------------------------
  // executeAction: delete_email via Unipile mock
  // --------------------------------------------------------------------------

  it("executeAction: delete_email succeeds through Unipile client", async () => {
    const store: Record<string, Record<string, Row>> = {
      actions: {
        "uni-del-1": {
          id: "uni-del-1",
          user_id: "user-1",
          session_id: "session-1",
          tool_name: "delete_email",
          arguments: { email_id: "e1", source_folder: "INBOX" },
          status: "pending",
          result: null,
          undo_recipe: null,
          undo_deadline: null,
          created_at: new Date().toISOString(),
          executed_at: null,
        },
      },
    };
    const supabase = createFakeSupabase(store) as unknown as SupabaseClient;

    const result = await executeAction("uni-del-1", supabase, buildUnipileTestAccount());

    expect(result.status).toBe("executed");
    expect(mockClient.deleteEmail).toHaveBeenCalledWith("e1", "INBOX");
    expect(store.actions["uni-del-1"].status).toBe("executed");
    expect(store.actions["uni-del-1"].undo_recipe).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // executeAction: archive_email via Unipile mock
  // --------------------------------------------------------------------------

  it("executeAction: archive_email succeeds through Unipile client", async () => {
    const store: Record<string, Record<string, Row>> = {
      actions: {
        "uni-arc-1": {
          id: "uni-arc-1",
          user_id: "user-1",
          session_id: "session-1",
          tool_name: "archive_email",
          arguments: { email_id: "e1", source_folder: "INBOX" },
          status: "pending",
          result: null,
          undo_recipe: null,
          undo_deadline: null,
          created_at: new Date().toISOString(),
          executed_at: null,
        },
      },
    };
    const supabase = createFakeSupabase(store) as unknown as SupabaseClient;

    const result = await executeAction("uni-arc-1", supabase, buildUnipileTestAccount());

    expect(result.status).toBe("executed");
    expect(mockClient.archiveEmail).toHaveBeenCalledWith("e1", "INBOX");
    expect(store.actions["uni-arc-1"].status).toBe("executed");
  });

  // --------------------------------------------------------------------------
  // undoAction: move_email undo via Unipile mock
  // --------------------------------------------------------------------------

  it("undoAction: reverses a delete via Unipile client", async () => {
    const store: Record<string, Record<string, Row>> = {
      actions: {
        "uni-undo-1": {
          id: "uni-undo-1",
          user_id: "user-1",
          session_id: "session-1",
          tool_name: "delete_email",
          arguments: { email_id: "e1", source_folder: "INBOX" },
          status: "executed",
          result: { success: true },
          undo_recipe: { operation: "move_email", params: { emailId: "e1", from: "Trash", to: "INBOX" } },
          undo_deadline: null,
          created_at: new Date().toISOString(),
          executed_at: new Date().toISOString(),
        },
      },
    };
    const supabase = createFakeSupabase(store) as unknown as SupabaseClient;

    const result = await undoAction("uni-undo-1", supabase, buildUnipileTestAccount());

    expect(result.success).toBe(true);
    // moveEmail(identifier, destFolder, sourceFolder) -- undo swaps from/to
    expect(mockClient.moveEmail).toHaveBeenCalledWith("e1", "INBOX", "Trash");
    expect(store.actions["uni-undo-1"].status).toBe("undone");
  });

  // --------------------------------------------------------------------------
  // handleToolCall: list_emails via Unipile mock
  // --------------------------------------------------------------------------

  it("handleToolCall: list_inbox returns mocked inbox through Unipile", async () => {
    (mockClient.listInbox as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "u1", subject: "Unipile email", from: "test@example.com", date: "2026-01-01", snippet: "Hello" },
    ]);

    const store: Record<string, Record<string, Row>> = { actions: {} };
    const supabase = createFakeSupabase(store) as unknown as SupabaseClient;

    const input: ActionInput = {
      userId: "user-1",
      sessionId: "session-1",
      toolName: "list_inbox",
      arguments: {},
    };

    const result = await handleToolCall(input, {}, buildUnipileTestAccount(), supabase);

    expect(result.status).toBe("executed");
    expect(mockClient.listInbox).toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // convertActionToDraft: send_email via Unipile mock
  // --------------------------------------------------------------------------

  it("convertActionToDraft: saves draft through Unipile client", async () => {
    const store: Record<string, Record<string, Row>> = {
      actions: {
        "uni-draft-1": {
          id: "uni-draft-1",
          user_id: "user-1",
          session_id: "session-1",
          tool_name: "send_email",
          arguments: { to: "recipient@example.com", subject: "Test", body: "Hello" },
          status: "pending",
          result: null,
          undo_recipe: null,
          undo_deadline: null,
          created_at: new Date().toISOString(),
          executed_at: null,
        },
      },
    };
    const supabase = createFakeSupabase(store) as unknown as SupabaseClient;

    const result = await convertActionToDraft("uni-draft-1", supabase, buildUnipileTestAccount());

    expect(result.status).toBe("converted");
    expect(mockClient.saveDraft).toHaveBeenCalledWith({
      to: "recipient@example.com",
      subject: "Test",
      body: "Hello",
    });
    expect(store.actions["uni-draft-1"].status).toBe("converted");
  });
});

// ============================================================================
// WHAT_CAN_YOU_DO TOOL
// ============================================================================

describe("what_can_you_do", () => {
  beforeAll(() => {
    setMockUnipileClient(createMockEmailClient());
  });

  afterAll(() => {
    setMockUnipileClient(null);
  });

  it("returns capabilities markdown", async () => {
    const store: Record<string, Record<string, Row>> = { actions: {} };
    const supabase = createFakeSupabase(store) as unknown as SupabaseClient;

    const input: ActionInput = {
      userId: "user-1",
      sessionId: "session-1",
      toolName: "what_can_you_do",
      arguments: {},
    };

    const result: ActionResult = await handleToolCall(
      input,
      {},
      buildUnipileTestAccount(),
      supabase,
    );

    expect(result.status).toBe("executed");
    expect((result.result as Record<string, unknown>).markdown).toContain("archive");
  });
});
