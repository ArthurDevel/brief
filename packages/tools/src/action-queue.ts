/**
 * Action queue: classifies, executes, queues, and undoes tool calls.
 *
 * This is the main entry point for processing tool calls from the voice
 * gateway. It determines whether an action should auto-execute or be
 * queued for approval, writes to the DB, and handles undo operations.
 *
 * Responsibilities:
 * - classifyAction: determine classification with user overrides
 * - handleToolCall: main entry point for processing a tool call
 * - executeAction: execute a pending/approved action
 * - convertActionToDraft: convert a pending send_email to a mailbox draft
 * - undoAction: reverse an executed action using its undo recipe
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ToolName,
  ActionClassification,
  ToolApprovalConfig,
  ActionInput,
  ActionResult,
  QueuedSend,
  UndoRecipe,
  UndoResult,
  BulkActionResult,
  BulkActionResponse,
} from "./types";
import type { EmailAccountRecord } from "@dublin/email";
import { getDefaultClassification } from "./classification";
import { CAPABILITIES_MARKDOWN } from "./definitions";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Classifies an action based on user config overrides and defaults.
 * send_email and reply_email are always mutating_queued regardless of user config.
 * @param toolName - The tool being called
 * @param userConfig - User's per-tool classification overrides
 * @returns The effective ActionClassification
 */
export function classifyAction(toolName: ToolName, userConfig: ToolApprovalConfig): ActionClassification {
  // send_email and reply_email are always queued -- cannot be overridden
  if (toolName === "send_email" || toolName === "reply_email") {
    return "mutating_queued";
  }

  // Check user overrides first, fall back to default
  if (userConfig[toolName]) {
    return userConfig[toolName];
  }

  return getDefaultClassification(toolName);
}

/**
 * Main entry point for processing a tool call from the voice gateway.
 * Classifies the action, then either executes immediately or queues for approval.
 * Writes the action to the DB in both cases.
 * @param input - The tool call input (userId, sessionId, toolName, arguments)
 * @param userConfig - User's per-tool classification overrides
 * @param emailAccount - The user's active email account record
 * @param supabase - Supabase client for DB operations
 * @returns ActionResult with the outcome
 */
export async function handleToolCall(
  input: ActionInput,
  userConfig: ToolApprovalConfig,
  emailAccount: EmailAccountRecord,
  supabase: SupabaseClient
): Promise<ActionResult> {
  // Intercept batch tools before the normal classify/dispatch flow
  if (input.toolName === "batch_archive_emails") {
    return await handleBatchArchive(input, emailAccount, supabase);
  }
  if (input.toolName === "batch_delete_emails") {
    return await handleBatchDelete(input, supabase);
  }

  const classification = classifyAction(input.toolName, userConfig);
  const requiresApproval = classification === "mutating_queued";

  if (requiresApproval) {
    // Queue for approval -- insert as pending, do not execute
    return await insertPendingAction(input, supabase);
  }

  // Execute immediately (read_only or mutating_auto)
  return await executeAndStore(input, emailAccount, supabase);
}

/**
 * Executes a pending or approved action via the provider-agnostic email client.
 * Stores the undo recipe and deadline in the action row after execution.
 * @param actionId - The action row ID to execute
 * @param supabase - Supabase client for DB operations
 * @param emailAccount - The user's active email account record
 * @returns ActionResult with the outcome
 */
export async function executeAction(
  actionId: string,
  supabase: SupabaseClient,
  emailAccount: EmailAccountRecord
): Promise<ActionResult> {
  // Load the action from DB
  const { data: action, error } = await supabase
    .from("actions")
    .select("*")
    .eq("id", actionId)
    .single();

  if (error || !action) {
    throw new Error(`Action ${actionId} not found: ${error?.message ?? "no data"}`);
  }

  if (action.status !== "pending" && action.status !== "approved") {
    throw new Error(`Action ${actionId} cannot be executed -- status is "${action.status}"`);
  }

  // Execute the tool (null sessionId -- skip filtering for approved-action execution)
  // Only dispatch errors trigger the "failed" transition. Infrastructure errors
  // (DB load/update failures) are transient and the action stays in its current state.
  let result: Record<string, unknown>;
  let undoRecipe: UndoRecipe | null;
  try {
    ({ result, undoRecipe } = await dispatchTool(
      action.tool_name as ToolName,
      action.arguments,
      emailAccount,
      supabase,
      action.user_id,
      null
    ));
  } catch (dispatchError) {
    const errorMessage = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);

    await supabase
      .from("actions")
      .update({
        status: "failed",
        result: { error: errorMessage },
      })
      .eq("id", actionId);

    throw dispatchError;
  }

  // Update the action row with result + undo recipe
  const { error: updateError } = await supabase
    .from("actions")
    .update({
      status: "executed",
      result,
      undo_recipe: undoRecipe,
      undo_deadline: null, // All actions are undoable indefinitely (or not at all)
      executed_at: new Date().toISOString(),
    })
    .eq("id", actionId);

  if (updateError) {
    throw new Error(`Failed to update action ${actionId}: ${updateError.message}`);
  }

  return {
    actionId,
    status: "executed",
    result,
    message: `Action ${action.tool_name} executed successfully`,
  };
}

/**
 * Converts a pending send_email or reply_email action into a draft in the user's mailbox.
 * For reply_email, fetches the original email's reply context to build threading headers.
 * Saves the draft via the provider-agnostic client, then marks the action as "converted".
 * On failure the action remains "pending" -- errors propagate to the caller.
 * @param actionId - The action row ID to convert
 * @param supabase - Supabase client for DB operations
 * @param emailAccount - The user's active email account record
 * @returns ActionResult with converted status and draftUid
 */
export async function convertActionToDraft(
  actionId: string,
  supabase: SupabaseClient,
  emailAccount: EmailAccountRecord
): Promise<ActionResult> {
  // Load the action from DB
  const { data: action, error } = await supabase
    .from("actions")
    .select("*")
    .eq("id", actionId)
    .single();

  if (error || !action) {
    throw new Error(`Action ${actionId} not found: ${error?.message ?? "no data"}`);
  }

  if (action.tool_name !== "send_email" && action.tool_name !== "reply_email") {
    throw new Error(`Action ${actionId} is not a send_email or reply_email action (tool_name: "${action.tool_name}")`);
  }

  if (action.status !== "pending") {
    throw new Error(`Action ${actionId} is not pending (status: "${action.status}")`);
  }

  const { createEmailAccountClient } = await import("@dublin/email");
  const emailClient = await createEmailAccountClient(emailAccount);

  let recipe: import("./types").UndoRecipe;

  if (action.tool_name === "reply_email") {
    // Fetch reply context from the original email, then save as draft with threading headers
    const context = await emailClient.fetchReplyContext(action.arguments.email_id as string);

    const replyAll = (action.arguments.reply_all as boolean) ?? false;
    const senderAddress = action.arguments._sender_address as string | undefined;

    // Build subject with Re: prefix
    const subject = /^re:/i.test(context.subject) ? context.subject : `Re: ${context.subject}`;

    // Build CC for reply-all
    const ccAddrs = replyAll
      ? [...context.to, ...context.cc].filter(addr => senderAddress ? addr.toLowerCase() !== senderAddress.toLowerCase() : true)
      : [];

    recipe = await emailClient.saveDraft({
      to: context.from,
      subject,
      body: action.arguments.body as string,
      cc: ccAddrs.length > 0 ? ccAddrs.join(", ") : undefined,
      inReplyTo: context.messageId,
      references: [...context.references, context.messageId].join(" "),
    }) as UndoRecipe;
  } else {
    // send_email: save draft directly from action arguments
    recipe = await emailClient.saveDraft({
      to: action.arguments.to as string,
      subject: action.arguments.subject as string,
      body: action.arguments.body as string,
    }) as UndoRecipe;
  }

  const draftUid = recipe.params.draftUid as string;

  // Mark action as converted
  const { error: updateError } = await supabase
    .from("actions")
    .update({
      status: "converted",
      result: { convertedToDraft: true, draftUid },
    })
    .eq("id", actionId);

  if (updateError) {
    throw new Error(`Failed to update action ${actionId}: ${updateError.message}`);
  }

  return {
    actionId,
    status: "converted",
    result: { convertedToDraft: true, draftUid },
    message: `Action ${action.tool_name} converted to draft successfully`,
  };
}

/**
 * Undoes an executed action using its stored undo recipe.
 * Reads the recipe from the action row, checks the deadline, and dispatches
 * the reverse operation (move_email, delete_draft, delete_memory, etc.).
 * @param actionId - The action row ID to undo
 * @param supabase - Supabase client for DB operations
 * @param emailAccount - The user's active email account record
 * @returns UndoResult indicating success or failure
 */
export async function undoAction(
  actionId: string,
  supabase: SupabaseClient,
  emailAccount: EmailAccountRecord
): Promise<UndoResult> {
  // Load the action from DB
  const { data: action, error } = await supabase
    .from("actions")
    .select("*")
    .eq("id", actionId)
    .single();

  if (error || !action) {
    return { success: false, message: `Action ${actionId} not found` };
  }

  if (action.status !== "executed") {
    return { success: false, message: `Action ${actionId} cannot be undone -- status is "${action.status}"` };
  }

  const undoRecipe = action.undo_recipe as UndoRecipe | null;

  if (!undoRecipe) {
    return { success: false, message: `Action ${actionId} is not undoable` };
  }

  // Check undo deadline
  if (action.undo_deadline) {
    const deadline = new Date(action.undo_deadline);
    if (new Date() > deadline) {
      return { success: false, message: `Undo deadline has passed for action ${actionId}` };
    }
  }

  // Dispatch the undo operation
  await dispatchUndo(undoRecipe, emailAccount, supabase);

  // Update the action status
  const { error: updateError } = await supabase
    .from("actions")
    .update({ status: "undone" })
    .eq("id", actionId);

  if (updateError) {
    throw new Error(`Failed to update action ${actionId} to undone: ${updateError.message}`);
  }

  return { success: true, message: `Action ${actionId} undone successfully` };
}

/**
 * Executes multiple actions in bulk via the provider-agnostic email client.
 * For custom IMAP accounts, email-move actions are executed sequentially.
 * Non-move actions fall back to individual executeAction calls.
 * @param actionIds - Array of action row IDs to execute
 * @param supabase - Supabase client for DB operations
 * @param emailAccount - The user's active email account record
 * @returns BulkActionResponse with per-action results and summary counts
 */
export async function bulkExecuteActions(
  actionIds: string[],
  supabase: SupabaseClient,
  emailAccount: EmailAccountRecord
): Promise<BulkActionResponse> {
  // Early return for empty input
  if (actionIds.length === 0) {
    return { total: 0, succeeded: 0, failed: 0, skipped: 0, results: [] };
  }

  // Step 1: Load all actions in one DB query
  const { data: actions, error } = await supabase
    .from("actions")
    .select("*")
    .in("id", actionIds);

  if (error) {
    throw new Error(`Failed to load actions: ${error.message}`);
  }

  const actionMap = new Map<string, Record<string, unknown>>();
  for (const action of actions ?? []) {
    actionMap.set(action.id as string, action);
  }

  const results: BulkActionResult[] = [];

  // Step 2: Separate pending actions from non-pending (skipped)
  const pendingActions: Record<string, unknown>[] = [];
  for (const id of actionIds) {
    const action = actionMap.get(id);
    if (!action) {
      results.push({ actionId: id, status: "failed", error: `Action ${id} not found` });
      continue;
    }
    if (action.status !== "pending") {
      results.push({ actionId: id, status: "skipped", error: null });
      continue;
    }
    pendingActions.push(action);
  }

  // Step 3: Execute all pending actions sequentially via executeAction
  for (const action of pendingActions) {
    try {
      await executeAction(action.id as string, supabase, emailAccount);
      results.push({ actionId: action.id as string, status: "executed", error: null });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({ actionId: action.id as string, status: "failed", error: errorMsg });
    }
  }

  // Step 4: Build summary
  const succeeded = results.filter((r) => r.status === "executed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  return {
    total: results.length,
    succeeded,
    failed,
    skipped,
    results,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Inserts a pending action into the DB without executing it.
 * @param input - The action input
 * @param supabase - Supabase client
 * @returns ActionResult with pending status
 */
async function insertPendingAction(
  input: ActionInput,
  supabase: SupabaseClient
): Promise<ActionResult> {
  const { data, error } = await supabase
    .from("actions")
    .insert({
      user_id: input.userId,
      session_id: input.sessionId,
      tool_name: input.toolName,
      arguments: input.arguments,
      status: "pending",
      requires_approval: true,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to insert pending action: ${error?.message ?? "no data"}`);
  }

  return {
    actionId: data.id,
    status: "pending",
    result: null,
    message: `Action ${input.toolName} queued for approval. Please approve it from the dashboard.`,
  };
}

/**
 * Executes a tool call and stores the result + undo recipe in the DB.
 * @param input - The action input
 * @param emailAccount - The user's active email account record
 * @param supabase - Supabase client
 * @returns ActionResult with executed status
 */
async function executeAndStore(
  input: ActionInput,
  emailAccount: EmailAccountRecord,
  supabase: SupabaseClient
): Promise<ActionResult> {
  const { result, undoRecipe } = await dispatchTool(
    input.toolName,
    input.arguments,
    emailAccount,
    supabase,
    input.userId,
    input.sessionId
  );

  const { data, error } = await supabase
    .from("actions")
    .insert({
      user_id: input.userId,
      session_id: input.sessionId,
      tool_name: input.toolName,
      arguments: input.arguments,
      result,
      status: "executed",
      requires_approval: false,
      undo_recipe: undoRecipe,
      undo_deadline: null,
      executed_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to insert executed action: ${error?.message ?? "no data"}`);
  }

  return {
    actionId: data.id,
    status: "executed",
    result,
    message: `Action ${input.toolName} executed successfully`,
  };
}

/**
 * Fans out a batch_archive_emails call into individual archive_email actions.
 * Processes emails sequentially. Each email gets its own action row with an individual undo recipe.
 * @param input - The batch action input containing email_ids in arguments
 * @param emailAccount - The user's active email account record
 * @param supabase - Supabase client for DB operations
 * @returns ActionResult with summary counts and all created actionIds
 */
async function handleBatchArchive(
  input: ActionInput,
  emailAccount: EmailAccountRecord,
  supabase: SupabaseClient
): Promise<ActionResult> {
  const emailIds = (input.arguments.email_ids as string[]) ?? [];
  const sourceFolder = (input.arguments.source_folder as string) ?? "INBOX";

  const total = emailIds.length;
  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];
  const actionIds: string[] = [];
  let firstSuccessfulActionId = "";

  for (const emailId of emailIds) {
    try {
      const individualInput: ActionInput = {
        userId: input.userId,
        sessionId: input.sessionId,
        toolName: "archive_email",
        arguments: { email_id: emailId, source_folder: sourceFolder },
      };

      const result = await executeAndStore(individualInput, emailAccount, supabase);
      actionIds.push(result.actionId);

      if (!firstSuccessfulActionId) {
        firstSuccessfulActionId = result.actionId;
      }
      succeeded++;
    } catch (err) {
      failed++;
      errors.push(`email ${emailId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    actionId: firstSuccessfulActionId || "",
    status: "executed",
    result: { total, succeeded, failed, errors, actionIds },
    message: `Archived ${succeeded} of ${total} emails (${failed} failed)`,
  };
}

/**
 * Fans out a batch_delete_emails call into individual pending delete_email actions.
 * Processes emails sequentially. Each email gets its own pending action row.
 * @param input - The batch action input containing email_ids in arguments
 * @param supabase - Supabase client for DB operations
 * @returns ActionResult with summary counts and all created actionIds
 */
async function handleBatchDelete(
  input: ActionInput,
  supabase: SupabaseClient
): Promise<ActionResult> {
  const emailIds = (input.arguments.email_ids as string[]) ?? [];
  const sourceFolder = (input.arguments.source_folder as string) ?? "INBOX";

  const total = emailIds.length;
  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];
  const actionIds: string[] = [];
  let firstSuccessfulActionId = "";

  for (const emailId of emailIds) {
    try {
      const individualInput: ActionInput = {
        userId: input.userId,
        sessionId: input.sessionId,
        toolName: "delete_email",
        arguments: { email_id: emailId, source_folder: sourceFolder },
      };

      const result = await insertPendingAction(individualInput, supabase);
      actionIds.push(result.actionId);

      if (!firstSuccessfulActionId) {
        firstSuccessfulActionId = result.actionId;
      }
      succeeded++;
    } catch (err) {
      failed++;
      errors.push(`email ${emailId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    actionId: firstSuccessfulActionId || "",
    status: "pending",
    result: { total, succeeded, failed, errors, actionIds },
    message: `Queued ${succeeded} of ${total} emails for deletion (${failed} failed)`,
  };
}

/**
 * Dispatches a tool call to the appropriate handler.
 * @param toolName - The tool to execute
 * @param args - The tool arguments
 * @param emailAccount - The user's active email account record
 * @param supabase - Supabase client
 * @param userId - The user ID (for memory/feature request operations)
 * @param sessionId - The session ID for filtering pending actions, or null to skip filtering
 * @returns The result data and undo recipe
 */
async function dispatchTool(
  toolName: ToolName,
  args: Record<string, unknown>,
  emailAccount: EmailAccountRecord,
  supabase: SupabaseClient,
  userId: string,
  sessionId: string | null
): Promise<{ result: Record<string, unknown>; undoRecipe: UndoRecipe | null }> {
  // Lazy import to avoid circular dependencies
  const { createEmailAccountClient } = await import("@dublin/email");
  const { formatEmailSummaries, formatEmail, formatThread, formatFolders } = await import("@dublin/email");

  // Build the provider-agnostic email client
  const emailClient = await createEmailAccountClient(emailAccount);

  // Determine sender address for reply operations
  const senderAddress = emailAccount.emailAddress ?? emailAccount.customConfig?.smtp.user ?? "";

  switch (toolName) {
    case "list_inbox": {
      const limit = (args.limit as number) ?? 5;

      // Filter out emails with pending removal actions in this session
      if (sessionId !== null) {
        const pendingIds = await fetchPendingEmailIds(sessionId, supabase);
        // Overfetch to compensate for filtered-out emails
        const emails = await emailClient.listInbox(limit + pendingIds.size);
        const filtered = emails.filter((e) => !pendingIds.has(e.id)).slice(0, limit);
        let markdown = formatEmailSummaries(filtered, "Inbox");

        // Append queued outgoing emails if any exist
        const sends = await fetchQueuedSends(sessionId, supabase);
        if (sends.length > 0) {
          markdown += "\n\n" + formatQueuedSends(sends);
        }

        return { result: { markdown }, undoRecipe: null };
      }

      const emails = await emailClient.listInbox(limit);
      return { result: { markdown: formatEmailSummaries(emails, "Inbox") }, undoRecipe: null };
    }

    case "read_email": {
      const email = await emailClient.readEmail(args.email_id as string);
      return { result: { markdown: formatEmail(email) }, undoRecipe: null };
    }

    case "read_thread": {
      const messages = await emailClient.readThread(args.email_id as string);
      return { result: { markdown: formatThread(messages) }, undoRecipe: null };
    }

    case "search_emails": {
      const emails = await emailClient.searchEmails(args.query as string);

      // Filter out emails with pending removal actions in this session
      if (sessionId !== null) {
        const pendingIds = await fetchPendingEmailIds(sessionId, supabase);
        const filtered = emails.filter((e) => !pendingIds.has(e.id));
        return { result: { markdown: formatEmailSummaries(filtered, "Search Results") }, undoRecipe: null };
      }

      return { result: { markdown: formatEmailSummaries(emails, "Search Results") }, undoRecipe: null };
    }

    case "mark_as_read": {
      await emailClient.markAsRead(args.email_id as string);
      return { result: { marked: true }, undoRecipe: null };
    }

    case "archive_email": {
      const sourceFolder = (args.source_folder as string) ?? "INBOX";
      const undoRecipe = await emailClient.archiveEmail(args.email_id as string, sourceFolder);
      return { result: { archived: true }, undoRecipe };
    }

    case "delete_email": {
      const sourceFolder = (args.source_folder as string) ?? "INBOX";
      const undoRecipe = await emailClient.deleteEmail(args.email_id as string, sourceFolder);
      return { result: { deleted: true }, undoRecipe };
    }

    case "draft_email": {
      const undoRecipe = await emailClient.saveDraft({
        to: args.to as string,
        subject: args.subject as string,
        body: args.body as string,
      });
      return { result: { drafted: true, draftUid: undoRecipe?.params.draftUid }, undoRecipe };
    }

    case "send_email": {
      await emailClient.sendEmail({
        to: args.to as string,
        subject: args.subject as string,
        body: args.body as string,
      });
      return { result: { sent: true }, undoRecipe: null };
    }

    case "reply_email": {
      const context = await emailClient.fetchReplyContext(args.email_id as string);
      await emailClient.replyEmail({
        context,
        body: args.body as string,
        replyAll: (args.reply_all as boolean) ?? false,
        senderAddress,
      });
      return { result: { sent: true }, undoRecipe: null };
    }

    case "list_folders": {
      const folders = await emailClient.listFolders();
      return { result: { markdown: formatFolders(folders) }, undoRecipe: null };
    }

    case "move_to_folder": {
      const sourceFolder = (args.source_folder as string) ?? "INBOX";
      const undoRecipe = await emailClient.moveToFolder(
        args.email_id as string,
        args.folder as string,
        sourceFolder
      );
      return { result: { moved: true }, undoRecipe };
    }

    case "save_memory": {
      return await handleSaveMemory(supabase, userId, args.content as string);
    }

    case "submit_feature_request": {
      return await handleFeatureRequest(supabase, userId, args.description as string);
    }

    case "what_can_you_do": {
      return { result: { markdown: CAPABILITIES_MARKDOWN }, undoRecipe: null };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

/**
 * Handles the save_memory tool -- inserts a new row into user_memory.
 * @param supabase - Supabase client
 * @param userId - The user ID
 * @param content - Markdown content to remember
 * @returns Result and undo recipe
 */
async function handleSaveMemory(
  supabase: SupabaseClient,
  userId: string,
  content: string
): Promise<{ result: Record<string, unknown>; undoRecipe: UndoRecipe | null }> {
  const { data, error } = await supabase
    .from("user_memory")
    .insert({ user_id: userId, content })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to save memory: ${error?.message ?? "no data"}`);
  }

  return {
    result: { saved: true, id: data.id },
    undoRecipe: { operation: "delete_memory", params: { id: data.id } },
  };
}

/**
 * Handles the submit_feature_request tool -- inserts into feature_requests table.
 * @param supabase - Supabase client
 * @param userId - The user ID
 * @param description - Feature request description
 * @returns Result and undo recipe
 */
async function handleFeatureRequest(
  supabase: SupabaseClient,
  userId: string,
  description: string
): Promise<{ result: Record<string, unknown>; undoRecipe: UndoRecipe | null }> {
  const { data, error } = await supabase
    .from("feature_requests")
    .insert({ user_id: userId, description, source: "voice" })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to submit feature request: ${error?.message ?? "no data"}`);
  }

  return {
    result: { submitted: true, id: data.id },
    undoRecipe: { operation: "delete_feature_request", params: { id: data.id } },
  };
}

/**
 * Dispatches an undo operation based on the undo recipe.
 * @param recipe - The undo recipe describing what to reverse
 * @param emailAccount - The user's active email account record
 * @param supabase - Supabase client (for memory/feature request undos)
 */
async function dispatchUndo(
  recipe: UndoRecipe,
  emailAccount: EmailAccountRecord,
  supabase: SupabaseClient
): Promise<void> {
  switch (recipe.operation) {
    case "move_email": {
      const { createEmailAccountClient } = await import("@dublin/email");
      const emailClient = await createEmailAccountClient(emailAccount);

      // Undo recipes use messageId (IMAP) or emailId (Unipile) as identifier
      const identifier = (recipe.params.emailId as string) ?? (recipe.params.messageId as string);
      const from = recipe.params.from as string;
      const to = recipe.params.to as string;

      await emailClient.moveEmail(identifier, to, from);
      break;
    }

    case "delete_draft": {
      const { createEmailAccountClient } = await import("@dublin/email");
      const emailClient = await createEmailAccountClient(emailAccount);
      await emailClient.deleteDraft(Number(recipe.params.draftUid));
      break;
    }

    case "delete_memory": {
      const { error } = await supabase
        .from("user_memory")
        .delete()
        .eq("id", recipe.params.id as string);

      if (error) {
        throw new Error(`Failed to delete memory: ${error.message}`);
      }
      break;
    }

    case "delete_feature_request": {
      const { error } = await supabase
        .from("feature_requests")
        .delete()
        .eq("id", recipe.params.id as string);

      if (error) {
        throw new Error(`Failed to delete feature request: ${error.message}`);
      }
      break;
    }

    default:
      throw new Error(`Unknown undo operation: ${(recipe as UndoRecipe).operation}`);
  }
}

/**
 * Queries the actions table for pending/approved delete_email and archive_email
 * actions in a given session. Returns the set of email_ids being acted on.
 * @param sessionId - The session to query
 * @param supabase - Supabase client for DB operations
 * @returns Set of email_id strings that have pending removal actions
 */
export async function fetchPendingEmailIds(
  sessionId: string,
  supabase: SupabaseClient
): Promise<Set<string>> {
  const { data: rows, error } = await supabase
    .from("actions")
    .select("arguments")
    .eq("session_id", sessionId)
    .in("tool_name", ["delete_email", "archive_email", "move_to_folder"])
    .in("status", ["pending", "approved"]);

  if (error) {
    throw new Error(`Failed to fetch pending email ids: ${error.message}`);
  }

  return new Set((rows ?? []).map((r: { arguments: Record<string, unknown> }) => r.arguments.email_id as string));
}

/**
 * Queries the actions table for pending/approved send_email actions in a
 * given session. Returns the to, subject, and status for each.
 * @param sessionId - The session to query
 * @param supabase - Supabase client for DB operations
 * @returns Array of QueuedSend objects
 */
export async function fetchQueuedSends(
  sessionId: string,
  supabase: SupabaseClient
): Promise<QueuedSend[]> {
  const { data: rows, error } = await supabase
    .from("actions")
    .select("arguments, status")
    .eq("session_id", sessionId)
    .eq("tool_name", "send_email")
    .in("status", ["pending", "approved"]);

  if (error) {
    throw new Error(`Failed to fetch queued sends: ${error.message}`);
  }

  return (rows ?? []).map((r: { arguments: Record<string, unknown>; status: string }) => ({
    to: r.arguments.to as string,
    subject: r.arguments.subject as string,
    status: r.status,
  }));
}

/**
 * Formats queued outgoing emails as a markdown section.
 * Returns an empty string if the list is empty.
 * @param sends - Array of QueuedSend objects to format
 * @returns Markdown string with the queued outgoing section
 */
export function formatQueuedSends(sends: QueuedSend[]): string {
  if (sends.length === 0) {
    return "";
  }

  const lines: string[] = [`## Queued Outgoing (${sends.length} emails)`, ""];

  for (const send of sends) {
    lines.push(`- **To:** ${send.to} | **Subject:** ${send.subject}`);
    lines.push(`  *Status: Awaiting approval*`);
    lines.push("");
  }

  return lines.join("\n");
}
