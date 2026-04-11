/**
 * Public token-scoped API for approving or rejecting session actions.
 *
 * This route is intentionally narrower than the authenticated dashboard action
 * APIs. A valid recap token can only approve/reject pending actions that belong
 * to the token's user and session.
 *
 * Responsibilities:
 * - Validate the session review token on every mutation
 * - Verify every requested action is inside the token-scoped session
 * - Reject pending actions with a scoped DB update
 * - Approve pending actions through the existing action execution path
 */

import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/client";
import { getActiveEmailAccountRecord } from "@/lib/email-accounts";
import {
  touchSessionReviewToken,
  validateSessionReviewToken,
  type SessionReviewTokenContext,
} from "@/lib/session-review-tokens";
import { bulkExecuteActions, type BulkActionResponse } from "@dublin/tools";

// ============================================================================
// CONSTANTS
// ============================================================================

const VALID_OPERATIONS = ["approve", "reject"] as const;

// ============================================================================
// TYPES
// ============================================================================

type SessionReviewOperation = (typeof VALID_OPERATIONS)[number];

interface SessionReviewActionRequest {
  token: string;
  operation: SessionReviewOperation;
  actionIds: string[];
}

interface LoadedAction {
  id: string;
  user_id: string;
  session_id: string;
  status: string;
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Approves or rejects token-scoped pending actions.
 * @param request - Incoming request with token, operation, and action IDs
 * @returns Bulk-style action response or error
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<BulkActionResponse | { error: string }>> {
  const body = await parseRequestBody(request);
  if (!body) {
    return NextResponse.json(
      { error: "Invalid request body. Expected { token: string, operation: \"approve\" | \"reject\", actionIds: string[] }" },
      { status: 400 }
    );
  }

  const supabase = createServiceRoleClient();
  const tokenContext = await validateSessionReviewToken(supabase, body.token);
  if (!tokenContext) {
    return NextResponse.json({ error: "Invalid or expired review link" }, { status: 401 });
  }

  const cookieStore = await cookies();
  const authClient = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await authClient.auth.getUser();
  if (user && user.id !== tokenContext.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const actions = await loadAndValidateActions(supabase, tokenContext, body.actionIds);
  if (!actions.valid) {
    return NextResponse.json({ error: actions.error }, { status: actions.status });
  }

  await touchSessionReviewToken(supabase, tokenContext.tokenId);

  if (body.operation === "reject") {
    return handleReject(supabase, tokenContext, body.actionIds, actions.rows);
  }

  return handleApprove(supabase, tokenContext, body.actionIds);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parses and validates the mutation request body.
 * @param request - Incoming request
 * @returns Valid request body or null
 */
async function parseRequestBody(request: NextRequest): Promise<SessionReviewActionRequest | null> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }

  if (typeof raw !== "object" || raw === null) return null;

  const { token, operation, actionIds } = raw as Record<string, unknown>;
  if (typeof token !== "string" || token.length === 0) return null;
  if (!VALID_OPERATIONS.includes(operation as SessionReviewOperation)) return null;
  if (!Array.isArray(actionIds) || actionIds.length === 0) return null;
  if (!actionIds.every((id) => typeof id === "string" && id.length > 0)) return null;

  return {
    token,
    operation: operation as SessionReviewOperation,
    actionIds: Array.from(new Set(actionIds as string[])),
  };
}

/**
 * Loads requested actions and verifies they are all token-scoped.
 * @param supabase - Service-role Supabase client
 * @param tokenContext - Validated token context
 * @param actionIds - Requested action IDs
 * @returns Loaded rows or an error descriptor
 */
async function loadAndValidateActions(
  supabase: ReturnType<typeof createServiceRoleClient>,
  tokenContext: SessionReviewTokenContext,
  actionIds: string[]
): Promise<
  | { valid: true; rows: LoadedAction[] }
  | { valid: false; error: string; status: number }
> {
  const { data, error } = await supabase
    .from("actions")
    .select("id, user_id, session_id, status")
    .in("id", actionIds);

  if (error) {
    return { valid: false, error: error.message, status: 500 };
  }

  const rows = (data ?? []) as LoadedAction[];
  if (rows.length !== actionIds.length) {
    return { valid: false, error: "One or more actions are invalid", status: 400 };
  }

  const outOfScope = rows.find(
    (action) =>
      action.user_id !== tokenContext.userId ||
      action.session_id !== tokenContext.sessionId
  );

  if (outOfScope) {
    return { valid: false, error: "Unauthorized action for this review link", status: 403 };
  }

  return { valid: true, rows };
}

/**
 * Rejects pending token-scoped actions.
 * @param supabase - Service-role Supabase client
 * @param tokenContext - Validated token context
 * @param actionIds - Requested action IDs
 * @param loadedActions - Loaded action rows
 * @returns Bulk-style reject response
 */
async function handleReject(
  supabase: ReturnType<typeof createServiceRoleClient>,
  tokenContext: SessionReviewTokenContext,
  actionIds: string[],
  loadedActions: LoadedAction[]
): Promise<NextResponse<BulkActionResponse | { error: string }>> {
  const { data: updated, error } = await supabase
    .from("actions")
    .update({ status: "rejected" })
    .in("id", actionIds)
    .eq("user_id", tokenContext.userId)
    .eq("session_id", tokenContext.sessionId)
    .eq("status", "pending")
    .select("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rejectedIds = new Set((updated ?? []).map((row) => row.id as string));
  const results = loadedActions.map((action) => ({
    actionId: action.id,
    status: rejectedIds.has(action.id) ? ("executed" as const) : ("skipped" as const),
    error: null,
  }));

  return NextResponse.json({
    total: results.length,
    succeeded: results.filter((result) => result.status === "executed").length,
    failed: 0,
    skipped: results.filter((result) => result.status === "skipped").length,
    results,
  });
}

/**
 * Approves pending token-scoped actions through existing execution logic.
 * @param supabase - Service-role Supabase client
 * @param tokenContext - Validated token context
 * @param actionIds - Requested action IDs
 * @returns Bulk-style approve response
 */
async function handleApprove(
  supabase: ReturnType<typeof createServiceRoleClient>,
  tokenContext: SessionReviewTokenContext,
  actionIds: string[]
): Promise<NextResponse<BulkActionResponse | { error: string }>> {
  const emailAccount = await getActiveEmailAccountRecord(
    supabase,
    supabase,
    tokenContext.userId
  );

  if (!emailAccount) {
    return NextResponse.json({ error: "No active email account configured" }, { status: 400 });
  }

  try {
    const response = await bulkExecuteActions(actionIds, supabase, emailAccount);
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to approve actions";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
