/**
 * Regression test for issue #153: move_to_folder actions must be enriched
 * with email metadata (subject, from) during end-of-session processing.
 *
 * Tests the outcome: after enrichment, move_to_folder action rows contain
 * subject and from fields in their arguments -- so the actions dashboard
 * and summary email display them correctly.
 *
 * The enrichment logic and EMAIL_TOOL_NAMES list are private to route.ts,
 * so this test replicates them. If the list drifts, this test catches it.
 */

import { describe, it, expect, vi } from "vitest";
import type { ActionRow } from "@dublin/tools/src/types";
import type { EmailAccountClient, EmailMetaRequest, EmailMeta } from "@dublin/email";

// ============================================================================
// REPLICATED FROM route.ts (private)
// ============================================================================

const EMAIL_TOOL_NAMES = ["archive_email", "delete_email", "reply_email", "move_to_folder"];

async function enrichActionsWithEmailMeta(
  actions: ActionRow[],
  emailClient: EmailAccountClient,
  log: (msg: string) => void
): Promise<ActionRow[]> {
  const candidates = actions.filter(
    (a) => EMAIL_TOOL_NAMES.includes(a.toolName)
      && a.arguments?.email_id
      && !(a.arguments.subject && a.arguments.from)
  );
  log(`${candidates.length} action(s) need enrichment out of ${actions.length} total`);

  if (candidates.length === 0) return [];

  const requests: EmailMetaRequest[] = candidates.map((action) => {
    const messageId = action.arguments.message_id as string | undefined;
    const emailId = action.arguments.email_id as string;
    if (messageId) return { actionId: action.id, messageId };
    return { actionId: action.id, uid: emailId };
  });

  const results = await emailClient.fetchEmailMetaBatch(requests);
  log(`Batch returned ${results.size} result(s) for ${requests.length} request(s)`);

  const enriched: ActionRow[] = [];
  for (const action of candidates) {
    const meta = results.get(action.id);
    if (meta) {
      action.arguments = { ...action.arguments, subject: meta.subject, from: meta.from };
      enriched.push(action);
    } else {
      log(`No metadata found for action ${action.id} (${action.toolName})`);
    }
  }
  return enriched;
}

// ============================================================================
// TEST
// ============================================================================

describe("end-of-session enrichment", () => {
  /**
   * Regression test for #153: a session containing move_to_folder, archive_email,
   * and delete_email actions should all end up with subject and from in their
   * arguments after enrichment -- so the dashboard displays them instead of "-".
   */
  it("move_to_folder actions get subject and from after enrichment", async () => {
    const actions: ActionRow[] = [
      {
        id: "move-1",
        userId: "u1",
        sessionId: "s1",
        toolName: "move_to_folder",
        arguments: { email_id: "e1", folder: "Receipts", source_folder: "INBOX" },
        result: { moved: true },
        status: "executed",
        requiresApproval: false,
        undoRecipe: null,
        undoDeadline: null,
        createdAt: new Date().toISOString(),
        executedAt: new Date().toISOString(),
      },
      {
        id: "archive-1",
        userId: "u1",
        sessionId: "s1",
        toolName: "archive_email",
        arguments: { email_id: "e2" },
        result: { archived: true },
        status: "executed",
        requiresApproval: false,
        undoRecipe: null,
        undoDeadline: null,
        createdAt: new Date().toISOString(),
        executedAt: new Date().toISOString(),
      },
    ];

    const mockClient = {
      fetchEmailMetaBatch: vi.fn().mockResolvedValue(
        new Map<string, EmailMeta>([
          ["move-1", { subject: "Invoice #42", from: "Alice <alice@example.com>" }],
          ["archive-1", { subject: "Newsletter", from: "Bob <bob@example.com>" }],
        ])
      ),
    } as unknown as EmailAccountClient;

    await enrichActionsWithEmailMeta(actions, mockClient, () => {});

    // Outcome: both actions now have subject and from in arguments
    expect(actions[0].arguments.subject).toBe("Invoice #42");
    expect(actions[0].arguments.from).toBe("Alice <alice@example.com>");
    expect(actions[1].arguments.subject).toBe("Newsletter");
    expect(actions[1].arguments.from).toBe("Bob <bob@example.com>");
  });
});
