"""
Action queue: classifies, executes, queues, and undoes tool calls.

Port of packages/tools/src/action-queue.ts.

Main entry point for processing tool calls from the voice pipeline.
Determines whether an action should auto-execute or be queued for
approval, writes to the DB, and handles undo operations.

- handle_tool_call: main entry point for processing a tool call
- execute_action: execute a pending/approved action by ID
- undo_action: reverse an executed action using its undo recipe
- _dispatch_tool: route tool calls to email_client or Supabase operations
- _dispatch_undo: route undo operations to reverse handlers
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import date as date_type, datetime, timedelta, timezone
from typing import Any, cast
from zoneinfo import ZoneInfo

from supabase import Client

from src.session import ImapConfig, _timezone_from_country_code
from src.tools.classification import classify_action
from src.tools.contact_matcher import rank_contacts
from src.tools.definitions import CAPABILITIES_MARKDOWN
from src.tools import email_client
from src.tools import unipile_client
from src.tools.email_client import EmailClientContext
from src.tools.markdown_formatter import format_email_summaries, format_email, format_folders, format_thread

logger = logging.getLogger(__name__)


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class ActionInput:
    """Input for a tool call from the voice pipeline."""

    user_id: str
    session_id: str
    tool_name: str
    arguments: dict[str, Any]


@dataclass
class ActionResult:
    """Result of processing a tool call."""

    action_id: str
    status: str  # "pending" | "executed"
    result: dict[str, Any] | None
    message: str


@dataclass
class UndoRecipe:
    """Instructions for reversing an executed action."""

    operation: str  # "move_email" | "delete_draft" | "delete_memory" | "delete_feature_request"
    params: dict[str, Any]


@dataclass
class QueuedSend:
    """A queued outgoing email awaiting approval or already approved."""

    to: str
    subject: str
    status: str  # "pending" | "approved"


@dataclass
class UndoResult:
    """Result of an undo operation."""

    success: bool
    message: str


# ============================================================================
# MAIN HANDLERS
# ============================================================================

def handle_tool_call(
    input: ActionInput,
    user_config: dict[str, str],
    email_ctx: EmailClientContext,
    supabase: Client,
) -> ActionResult:
    """Main entry point for processing a tool call from the voice pipeline.

    Classifies the action, then either queues as pending or executes immediately.
    Writes the action to the DB in both cases. Routes through the provider-aware
    email client context so handlers do not need to know which provider is used.

    Args:
        input: The tool call input (user_id, session_id, tool_name, arguments).
        user_config: User's per-tool classification overrides.
        email_ctx: Provider-aware email client context (IMAP/SMTP or Unipile).
        supabase: Supabase client for DB operations.

    Returns:
        ActionResult with the outcome.
    """
    # Intercept batch tools before the normal classify/dispatch flow
    if input.tool_name == "batch_archive_emails":
        return _handle_batch_archive(input, email_ctx, supabase)
    if input.tool_name == "batch_delete_emails":
        return _handle_batch_delete(input, supabase)
    if input.tool_name == "batch_move_to_folder":
        return _handle_batch_move(input, email_ctx, supabase)

    classification = classify_action(input.tool_name, user_config)
    requires_approval = classification == "mutating_queued"

    if requires_approval:
        return _insert_pending_action(input, supabase)

    # Execute immediately (read_only or mutating_auto)
    return _execute_and_store(input, email_ctx, supabase)


def execute_action(
    action_id: str,
    supabase: Client,
    email_ctx: EmailClientContext,
) -> ActionResult:
    """Execute a pending/approved action by ID (called by dashboard approve flow).

    Loads action row, dispatches tool, writes result + undo_recipe.

    Args:
        action_id: The action row ID to execute.
        supabase: Supabase client for DB operations.
        email_ctx: Provider-aware email client context (IMAP/SMTP or Unipile).

    Returns:
        ActionResult with the outcome.

    Raises:
        RuntimeError: If the action is not found or cannot be executed.
    """
    # Load the action from DB
    response = (
        supabase.table("actions")
        .select("*")
        .eq("id", action_id)
        .single()
        .execute()
    )

    if response.data is None:
        raise RuntimeError(f"Action {action_id} not found")

    action = cast(dict[str, Any], response.data)

    if action["status"] not in ("pending", "approved"):
        raise RuntimeError(
            f'Action {action_id} cannot be executed -- status is "{action["status"]}"'
        )

    # Execute the tool (None session_id -- skip filtering for approved-action execution)
    result, undo_recipe, _ = _dispatch_tool(
        tool_name=action["tool_name"],
        args=action["arguments"],
        email_ctx=email_ctx,
        supabase=supabase,
        user_id=action["user_id"],
        session_id=None,
    )

    # Serialize undo recipe for DB storage
    undo_recipe_data = (
        {"operation": undo_recipe.operation, "params": undo_recipe.params}
        if undo_recipe
        else None
    )

    # Update the action row with result + undo recipe
    update_response = (
        supabase.table("actions")
        .update({
            "status": "executed",
            "result": result,
            "undo_recipe": undo_recipe_data,
            "undo_deadline": None,
            "executed_at": datetime.now(timezone.utc).isoformat(),
        })
        .eq("id", action_id)
        .execute()
    )

    if not update_response.data:
        raise RuntimeError(f"Failed to update action {action_id}")

    return ActionResult(
        action_id=action_id,
        status="executed",
        result=result,
        message=f"Action {action['tool_name']} executed successfully",
    )


def undo_action(
    action_id: str,
    supabase: Client,
    email_ctx: EmailClientContext,
) -> UndoResult:
    """Reverse an executed action using its stored undo recipe.

    Checks deadline, dispatches reverse operation, sets status to "undone".

    Args:
        action_id: The action row ID to undo.
        supabase: Supabase client for DB operations.
        email_ctx: Provider-aware email client context (IMAP/SMTP or Unipile).

    Returns:
        UndoResult indicating success or failure.
    """
    # Load the action from DB
    response = (
        supabase.table("actions")
        .select("*")
        .eq("id", action_id)
        .single()
        .execute()
    )

    if response.data is None:
        return UndoResult(success=False, message=f"Action {action_id} not found")

    action = cast(dict[str, Any], response.data)

    if action["status"] != "executed":
        return UndoResult(
            success=False,
            message=f'Action {action_id} cannot be undone -- status is "{action["status"]}"',
        )

    undo_recipe_data = cast(dict[str, Any] | None, action.get("undo_recipe"))
    if not undo_recipe_data:
        return UndoResult(success=False, message=f"Action {action_id} is not undoable")

    recipe = UndoRecipe(
        operation=undo_recipe_data["operation"],
        params=undo_recipe_data["params"],
    )

    # Check undo deadline
    if action.get("undo_deadline"):
        deadline = datetime.fromisoformat(str(action["undo_deadline"]))
        if datetime.now(timezone.utc) > deadline:
            return UndoResult(
                success=False,
                message=f"Undo deadline has passed for action {action_id}",
            )

    # Dispatch the undo operation
    _dispatch_undo(recipe, email_ctx, supabase)

    # Update the action status
    update_response = (
        supabase.table("actions")
        .update({"status": "undone"})
        .eq("id", action_id)
        .execute()
    )

    if not update_response.data:
        raise RuntimeError(f"Failed to update action {action_id} to undone")

    return UndoResult(success=True, message=f"Action {action_id} undone successfully")


# ============================================================================
# BATCH HANDLERS
# ============================================================================

def _handle_batch_archive(
    input: ActionInput,
    email_ctx: EmailClientContext,
    supabase: Client,
) -> ActionResult:
    """Fan out a batch archive request into individual archive_email actions.

    Loops sequentially over each email_id, calling _execute_and_store for each.
    Each iteration constructs a fresh ActionInput with a fresh arguments dict
    because _execute_and_store mutates input.arguments in-place (adds message_id).

    Args:
        input: The batch action input containing email_ids in arguments.
        email_ctx: Provider-aware email client context (IMAP/SMTP or Unipile).
        supabase: Supabase client for DB operations.

    Returns:
        ActionResult with summary counts and all created action IDs.
    """
    email_ids: list[str] = input.arguments.get("email_ids", [])
    source_folder: str = input.arguments.get("source_folder", "INBOX")

    total = len(email_ids)
    succeeded = 0
    failed = 0
    errors: list[str] = []
    action_ids: list[str] = []
    first_action_id = ""

    for email_id in email_ids:
        # Fresh ActionInput + fresh dict per iteration (critical -- see plan notes)
        individual_input = ActionInput(
            user_id=input.user_id,
            session_id=input.session_id,
            tool_name="archive_email",
            arguments={"email_id": email_id, "source_folder": source_folder},
        )
        try:
            result = _execute_and_store(individual_input, email_ctx, supabase)
            action_ids.append(result.action_id)
            if not first_action_id:
                first_action_id = result.action_id
            succeeded += 1
        except Exception as e:
            failed += 1
            errors.append(f"email_id={email_id}: {e}")
            logger.warning("Batch archive failed for email_id=%s: %s", email_id, e)

    return ActionResult(
        action_id=first_action_id or "",
        status="executed",
        result={"total": total, "succeeded": succeeded, "failed": failed, "errors": errors, "actionIds": action_ids},
        message=f"Archived {succeeded} of {total} emails ({failed} failed)",
    )


def _handle_batch_delete(
    input: ActionInput,
    supabase: Client,
) -> ActionResult:
    """Fan out a batch delete request into individual pending delete_email actions.

    Loops sequentially over each email_id, calling _insert_pending_action for each.
    Each iteration constructs a fresh ActionInput with a fresh arguments dict.

    Args:
        input: The batch action input containing email_ids in arguments.
        supabase: Supabase client for DB operations.

    Returns:
        ActionResult with summary counts and all created action IDs.
    """
    email_ids: list[str] = input.arguments.get("email_ids", [])
    source_folder: str = input.arguments.get("source_folder", "INBOX")

    total = len(email_ids)
    succeeded = 0
    failed = 0
    errors: list[str] = []
    action_ids: list[str] = []
    first_action_id = ""

    for email_id in email_ids:
        # Fresh ActionInput + fresh dict per iteration
        individual_input = ActionInput(
            user_id=input.user_id,
            session_id=input.session_id,
            tool_name="delete_email",
            arguments={"email_id": email_id, "source_folder": source_folder},
        )
        try:
            result = _insert_pending_action(individual_input, supabase)
            action_ids.append(result.action_id)
            if not first_action_id:
                first_action_id = result.action_id
            succeeded += 1
        except Exception as e:
            failed += 1
            errors.append(f"email_id={email_id}: {e}")
            logger.warning("Batch delete failed for email_id=%s: %s", email_id, e)

    return ActionResult(
        action_id=first_action_id or "",
        status="pending",
        result={"total": total, "succeeded": succeeded, "failed": failed, "errors": errors, "actionIds": action_ids},
        message=f"Queued {succeeded} of {total} emails for deletion ({failed} failed)",
    )


def _handle_batch_move(
    input: ActionInput,
    email_ctx: EmailClientContext,
    supabase: Client,
) -> ActionResult:
    """Move multiple emails to a folder in a single batch.

    For Unipile accounts: resolves the source folder once, then makes one PUT
    call per email (no per-email folder validation or re-dispatching).
    For IMAP accounts: falls back to individual _execute_and_store calls.

    Args:
        input: The batch action input containing email_ids, folder, and optional source_folder.
        email_ctx: Provider-aware email client context (IMAP/SMTP or Unipile).
        supabase: Supabase client for DB operations.

    Returns:
        ActionResult with summary counts and all created action IDs.
    """
    email_ids: list[str] = input.arguments.get("email_ids", [])
    folder: str = input.arguments["folder"]
    source_folder: str = input.arguments.get("source_folder", "INBOX")

    total = len(email_ids)
    if total == 0:
        return ActionResult(
            action_id="",
            status="executed",
            result={"total": 0, "succeeded": 0, "failed": 0, "errors": [], "actionIds": []},
            message=f"Moved 0 of 0 emails to {folder} (0 failed)",
        )

    if email_ctx.connection_type == "unipile":
        account_id = email_ctx.unipile_account_id
        if not account_id:
            raise RuntimeError("Unipile account has no account_id")

        # Pipecat runs tool handlers on worker threads without an event loop.
        # Create a fresh loop for the batch Unipile calls, matching the normal dispatch path.
        loop = asyncio.new_event_loop()
        try:
            folders = loop.run_until_complete(unipile_client.list_folders(account_id))
            folder_paths = [f.path for f in folders]
            if not any(p.lower() == folder.lower() for p in folder_paths):
                raise ValueError(
                    f'Folder "{folder}" does not exist. Available folders: {", ".join(folder_paths)}'
                )

            # Batch move via Unipile -- resolves source folder once, one PUT per email
            move_results = loop.run_until_complete(
                unipile_client.batch_move_to_folder(account_id, email_ids, folder, source_folder, email_ctx.provider)
            )
        finally:
            loop.close()

        # Store each result as an individual action row in the DB
        succeeded = 0
        failed = 0
        errors: list[str] = []
        action_ids: list[str] = []
        first_action_id = ""

        for item in move_results:
            if item["succeeded"]:
                undo_recipe_data = item["undo_recipe"]
                response = (
                    supabase.table("actions")
                    .insert({
                        "user_id": input.user_id,
                        "session_id": input.session_id,
                        "tool_name": "move_to_folder",
                        "arguments": {"email_id": item["email_id"], "folder": folder, "source_folder": source_folder},
                        "result": {"moved": True},
                        "status": "executed",
                        "requires_approval": False,
                        "undo_recipe": undo_recipe_data,
                        "undo_deadline": None,
                        "executed_at": datetime.now(timezone.utc).isoformat(),
                    })
                    .execute()
                )
                if response.data:
                    data = cast(list[dict[str, Any]], response.data)
                    action_id = data[0]["id"]
                    action_ids.append(action_id)
                    if not first_action_id:
                        first_action_id = action_id
                succeeded += 1
            else:
                failed += 1
                errors.append(f"email_id={item['email_id']}: {item.get('error', 'unknown')}")
                logger.warning("Batch move failed for email_id=%s: %s", item["email_id"], item.get("error"))

        return ActionResult(
            action_id=first_action_id or "",
            status="executed",
            result={"total": total, "succeeded": succeeded, "failed": failed, "errors": errors, "actionIds": action_ids},
            message=f"Moved {succeeded} of {total} emails to {folder} ({failed} failed)",
        )

    # IMAP fallback: fan out into individual _execute_and_store calls
    succeeded = 0
    failed = 0
    errors = []
    action_ids = []
    first_action_id = ""

    for email_id in email_ids:
        individual_input = ActionInput(
            user_id=input.user_id,
            session_id=input.session_id,
            tool_name="move_to_folder",
            arguments={"email_id": email_id, "folder": folder, "source_folder": source_folder},
        )
        try:
            result = _execute_and_store(individual_input, email_ctx, supabase)
            action_ids.append(result.action_id)
            if not first_action_id:
                first_action_id = result.action_id
            succeeded += 1
        except Exception as e:
            failed += 1
            errors.append(f"email_id={email_id}: {e}")
            logger.warning("Batch move failed for email_id=%s: %s", email_id, e)

    return ActionResult(
        action_id=first_action_id or "",
        status="executed",
        result={"total": total, "succeeded": succeeded, "failed": failed, "errors": errors, "actionIds": action_ids},
        message=f"Moved {succeeded} of {total} emails to {folder} ({failed} failed)",
    )


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _insert_pending_action(input: ActionInput, supabase: Client) -> ActionResult:
    """Insert a pending action into the DB without executing it.

    Args:
        input: The action input.
        supabase: Supabase client.

    Returns:
        ActionResult with pending status.

    Raises:
        RuntimeError: If the database insert fails.
    """
    response = (
        supabase.table("actions")
        .insert({
            "user_id": input.user_id,
            "session_id": input.session_id,
            "tool_name": input.tool_name,
            "arguments": input.arguments,
            "status": "pending",
            "requires_approval": True,
        })
        .execute()
    )

    if not response.data:
        raise RuntimeError("Failed to insert pending action: no data returned")

    data = cast(list[dict[str, Any]], response.data)
    action_id = data[0]["id"]

    return ActionResult(
        action_id=action_id,
        status="pending",
        result=None,
        message=f"Action {input.tool_name} queued for approval. Please approve it from the dashboard.",
    )


def _execute_and_store(
    input: ActionInput,
    email_ctx: EmailClientContext,
    supabase: Client,
) -> ActionResult:
    """Dispatch a tool call and store the result + undo recipe in the DB.

    Args:
        input: The action input.
        email_ctx: Provider-aware email client context (IMAP/SMTP or Unipile).
        supabase: Supabase client.

    Returns:
        ActionResult with executed status.

    Raises:
        RuntimeError: If the database insert fails.
    """
    result, undo_recipe, message_id = _dispatch_tool(
        tool_name=input.tool_name,
        args=input.arguments,
        email_ctx=email_ctx,
        supabase=supabase,
        user_id=input.user_id,
        session_id=input.session_id,
    )

    # Merge message_id into arguments for DB storage (used for enrichment later)
    if message_id is not None:
        input.arguments["message_id"] = message_id

    # Serialize undo recipe for DB storage
    undo_recipe_data = (
        {"operation": undo_recipe.operation, "params": undo_recipe.params}
        if undo_recipe
        else None
    )

    response = (
        supabase.table("actions")
        .insert({
            "user_id": input.user_id,
            "session_id": input.session_id,
            "tool_name": input.tool_name,
            "arguments": input.arguments,
            "result": result,
            "status": "executed",
            "requires_approval": False,
            "undo_recipe": undo_recipe_data,
            "undo_deadline": None,
            "executed_at": datetime.now(timezone.utc).isoformat(),
        })
        .execute()
    )

    if not response.data:
        raise RuntimeError("Failed to insert executed action: no data returned")

    data = cast(list[dict[str, Any]], response.data)
    action_id = data[0]["id"]

    return ActionResult(
        action_id=action_id,
        status="executed",
        result=result,
        message=f"Action {input.tool_name} executed successfully",
    )


def _dispatch_tool(
    tool_name: str,
    args: dict[str, Any],
    email_ctx: EmailClientContext,
    supabase: Client,
    user_id: str,
    session_id: str | None = None,
) -> tuple[dict[str, Any], UndoRecipe | None, str | None]:
    """Dispatch a tool call to the appropriate handler.

    Routes to email_client (IMAP/SMTP), unipile_client, or Supabase inserts
    for memory/feature requests. Provider selection is based on
    email_ctx.connection_type.

    Args:
        tool_name: The tool to execute.
        args: The tool arguments.
        email_ctx: Provider-aware email client context.
        supabase: Supabase client.
        user_id: The user ID (for memory/feature request operations).
        session_id: The session ID for filtering pending actions, or None to skip filtering.

    Returns:
        Tuple of (result dict, UndoRecipe or None, message_id or None).
        message_id is only returned for archive_email and delete_email.

    Raises:
        ValueError: If tool_name is unknown.
    """
    # For Unipile accounts, delegate email operations to the Unipile client
    if email_ctx.connection_type == "unipile":
        return _dispatch_tool_unipile(tool_name, args, email_ctx, supabase, user_id, session_id)

    # Custom (imap_smtp) account path -- existing IMAP/SMTP logic
    imap_holder = email_ctx.imap_holder
    smtp_config = email_ctx.smtp_config
    if imap_holder is None or smtp_config is None:
        raise RuntimeError("imap_holder and smtp_config are required for imap_smtp accounts")

    config: ImapConfig = imap_holder["config"]

    if tool_name == "list_inbox":
        limit = args.get("limit", 20)

        # Parse optional since parameter (ISO 8601 datetime string)
        since: datetime | None = None
        since_raw = args.get("since")
        if since_raw is not None:
            try:
                since = datetime.fromisoformat(since_raw)
            except (ValueError, TypeError):
                return {"error": "Invalid since format. Expected ISO 8601 datetime string."}, None, None

        # Filter out emails with pending removal actions in this session
        if session_id is not None:
            pending_ids = _fetch_pending_email_ids(session_id, supabase)

            if since is not None:
                # When since is set, ignore limit -- email_client handles the cap
                _since = since  # capture for lambda
                emails = email_client.with_reconnect(
                    imap_holder, config,
                    lambda c: email_client.list_inbox(c, 0, since=_since),
                )
            else:
                # Overfetch to compensate for filtered-out emails
                overfetch_limit = limit + len(pending_ids)
                emails = email_client.with_reconnect(
                    imap_holder, config,
                    lambda c: email_client.list_inbox(c, overfetch_limit),
                )

            filtered = [e for e in emails if e.id not in pending_ids]
            if since is None:
                filtered = filtered[:limit]
            markdown = format_email_summaries(filtered, "Inbox")

            # Append queued outgoing emails if any exist
            sends = _fetch_queued_sends(session_id, supabase)
            if sends:
                markdown += "\n\n" + _format_queued_sends(sends)

            return {"markdown": markdown}, None, None

        if since is not None:
            _since = since  # capture for lambda
            emails = email_client.with_reconnect(
                imap_holder, config,
                lambda c: email_client.list_inbox(c, 0, since=_since),
            )
        else:
            emails = email_client.with_reconnect(
                imap_holder, config,
                lambda c: email_client.list_inbox(c, limit),
            )
        return {"markdown": format_email_summaries(emails, "Inbox")}, None, None

    if tool_name == "read_email":
        result = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.read_email(c, args["email_id"]),
        )
        return {"markdown": format_email(result)}, None, None

    if tool_name == "read_thread":
        messages = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.read_thread(c, args["email_id"]),
        )
        return {"markdown": format_thread(messages)}, None, None

    if tool_name == "search_emails":
        emails = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.search_emails(c, args["query"]),
        )

        # Filter out emails with pending removal actions in this session
        if session_id is not None:
            pending_ids = _fetch_pending_email_ids(session_id, supabase)
            filtered = [e for e in emails if e.id not in pending_ids]
            return {"markdown": format_email_summaries(filtered, "Search Results")}, None, None

        return {"markdown": format_email_summaries(emails, "Search Results")}, None, None

    if tool_name == "mark_as_read":
        email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.mark_as_read(c, args["email_id"]),
        )
        return {"marked": True}, None, None

    if tool_name == "archive_email":
        source_folder = args.get("source_folder", "INBOX")
        recipe_data, message_id = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.archive_email(c, args["email_id"], source_folder),
        )
        return {"archived": True}, UndoRecipe(**recipe_data), message_id

    if tool_name == "delete_email":
        source_folder = args.get("source_folder", "INBOX")
        recipe_data, message_id = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.delete_email(c, args["email_id"], source_folder),
        )
        return {"deleted": True}, UndoRecipe(**recipe_data), message_id

    if tool_name == "draft_email":
        recipe_data = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.save_draft(c, args["to"], args["subject"], args["body"]),
        )
        return {"drafted": True, "draft_uid": recipe_data["params"]["draft_uid"]}, UndoRecipe(**recipe_data), None

    if tool_name == "send_email":
        # Run async SMTP send in the current event loop
        asyncio.get_event_loop().run_until_complete(
            email_client.send_email(smtp_config, args["to"], args["subject"], args["body"])
        )
        return {"sent": True}, None, None

    if tool_name == "reply_email":
        # Fetch original email headers via IMAP, then send reply via SMTP
        context = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.fetch_reply_context(c, args["email_id"]),
        )
        reply_all = args.get("reply_all", False)
        asyncio.get_event_loop().run_until_complete(
            email_client.reply_to_email(smtp_config, context, args["body"], reply_all, smtp_config.user)
        )
        return {"sent": True}, None, None

    if tool_name == "list_folders":
        folders = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.list_folders(c),
        )
        return {"folders": [{"path": f.path, "name": f.name, "special_use": f.special_use} for f in folders]}, None, None

    if tool_name == "move_to_folder":
        source_folder = args.get("source_folder", "INBOX")
        target_folder = args["folder"]

        # Validate folder exists before attempting move (both Gmail and IMAP silently accept invalid folders)
        folders = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.list_folders(c),
        )
        folder_paths = [f.path for f in folders]
        if not any(p.lower() == target_folder.lower() for p in folder_paths):
            raise ValueError(
                f'Folder "{target_folder}" does not exist. Available folders: {", ".join(folder_paths)}'
            )

        recipe_data, message_id = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.move_email_to_folder(c, args["email_id"], target_folder, source_folder),
        )
        return {"moved": True}, UndoRecipe(**recipe_data), message_id

    # Non-email tools: same for both providers
    return _dispatch_non_email_tool(tool_name, args, supabase, user_id, session_id)


def _dispatch_tool_unipile(
    tool_name: str,
    args: dict[str, Any],
    email_ctx: EmailClientContext,
    supabase: Client,
    user_id: str,
    session_id: str | None = None,
) -> tuple[dict[str, Any], UndoRecipe | None, str | None]:
    """Dispatch an email tool call through the Unipile client.

    Runs async Unipile operations via asyncio.get_event_loop().run_until_complete().

    Args:
        tool_name: The tool to execute.
        args: The tool arguments.
        email_ctx: Unipile email client context.
        supabase: Supabase client.
        user_id: The user ID.
        session_id: The session ID for filtering, or None.

    Returns:
        Tuple of (result dict, UndoRecipe or None, message_id or None).

    Raises:
        ValueError: If tool_name is unknown.
    """
    account_id = email_ctx.unipile_account_id
    if not account_id:
        raise RuntimeError("unipile_account_id is required for Unipile dispatch")

    # Pipecat runs tool handlers on worker threads without an event loop.
    # Create a fresh loop for running async Unipile calls.
    loop = asyncio.new_event_loop()

    try:
        if tool_name == "list_inbox":
            limit = args.get("limit", 20)
            emails = loop.run_until_complete(unipile_client.list_inbox(account_id, limit))

            # Filter out emails with pending removal actions in this session
            if session_id is not None:
                pending_ids = _fetch_pending_email_ids(session_id, supabase)
                filtered = [e for e in emails if e.id not in pending_ids]
                filtered = filtered[:limit]
                markdown = format_email_summaries(filtered, "Inbox")

                sends = _fetch_queued_sends(session_id, supabase)
                if sends:
                    markdown += "\n\n" + _format_queued_sends(sends)

                return {"markdown": markdown}, None, None

            return {"markdown": format_email_summaries(emails, "Inbox")}, None, None

        if tool_name == "read_email":
            result = loop.run_until_complete(unipile_client.read_email(account_id, args["email_id"]))
            return {"markdown": format_email(result)}, None, None

        if tool_name == "read_thread":
            # TODO: Implement Unipile thread reading
            raise NotImplementedError("read_thread is not yet implemented for Unipile accounts")

        if tool_name == "search_emails":
            emails = loop.run_until_complete(unipile_client.search_emails(account_id, args["query"]))

            if session_id is not None:
                pending_ids = _fetch_pending_email_ids(session_id, supabase)
                filtered = [e for e in emails if e.id not in pending_ids]
                return {"markdown": format_email_summaries(filtered, "Search Results")}, None, None

            return {"markdown": format_email_summaries(emails, "Search Results")}, None, None

        if tool_name == "mark_as_read":
            # TODO: Implement Unipile mark_as_read
            raise NotImplementedError("mark_as_read is not yet implemented for Unipile accounts")

        if tool_name == "archive_email":
            source_folder = args.get("source_folder", "INBOX")
            undo_recipe_data, message_id = loop.run_until_complete(
                unipile_client.archive_email(account_id, args["email_id"], source_folder, email_ctx.provider)
            )
            recipe = UndoRecipe(**undo_recipe_data) if undo_recipe_data else None
            return {"archived": True}, recipe, message_id

        if tool_name == "delete_email":
            source_folder = args.get("source_folder", "INBOX")
            undo_recipe_data, message_id = loop.run_until_complete(
                unipile_client.delete_email(account_id, args["email_id"], source_folder, email_ctx.provider)
            )
            recipe = UndoRecipe(**undo_recipe_data) if undo_recipe_data else None
            return {"deleted": True}, recipe, message_id

        if tool_name == "draft_email":
            undo_recipe_data = loop.run_until_complete(
                unipile_client.save_draft(account_id, args["to"], args["subject"], args["body"])
            )
            recipe = UndoRecipe(**undo_recipe_data) if undo_recipe_data else None
            draft_id = undo_recipe_data.get("params", {}).get("draft_id", "") if undo_recipe_data else ""
            return {"drafted": True, "draft_id": draft_id}, recipe, None

        if tool_name == "send_email":
            loop.run_until_complete(
                unipile_client.send_email(account_id, args["to"], args["subject"], args["body"])
            )
            return {"sent": True}, None, None

        if tool_name == "reply_email":
            # TODO: Implement Unipile reply with threading
            raise NotImplementedError("reply_email is not yet implemented for Unipile accounts")

        if tool_name == "list_folders":
            folders = loop.run_until_complete(unipile_client.list_folders(account_id))
            return {"folders": [{"path": f.path, "name": f.name, "special_use": f.special_use} for f in folders]}, None, None

        if tool_name == "move_to_folder":
            source_folder = args.get("source_folder", "INBOX")
            target_folder = args["folder"]

            # Validate folder exists before attempting move (Unipile silently accepts invalid folders)
            folders = loop.run_until_complete(unipile_client.list_folders(account_id))
            folder_paths = [f.path for f in folders]
            if not any(p.lower() == target_folder.lower() for p in folder_paths):
                raise ValueError(
                    f'Folder "{target_folder}" does not exist. Available folders: {", ".join(folder_paths)}'
                )

            undo_recipe_data, message_id = loop.run_until_complete(
                unipile_client.move_to_folder(account_id, args["email_id"], target_folder, source_folder, email_ctx.provider)
            )
            recipe = UndoRecipe(**undo_recipe_data) if undo_recipe_data else None
            return {"moved": True}, recipe, message_id

        # Non-email tools: same for both providers
        return _dispatch_non_email_tool(tool_name, args, supabase, user_id, session_id)
    finally:
        loop.close()


def _dispatch_non_email_tool(
    tool_name: str,
    args: dict[str, Any],
    supabase: Client,
    user_id: str,
    session_id: str | None = None,
) -> tuple[dict[str, Any], UndoRecipe | None, str | None]:
    """Dispatch non-email tool calls (memory, feature requests, contacts, etc.).

    These tools work the same regardless of email provider.

    Args:
        tool_name: The tool to execute.
        args: The tool arguments.
        supabase: Supabase client.
        user_id: The user ID.
        session_id: The session ID (unused but kept for signature consistency).

    Returns:
        Tuple of (result dict, UndoRecipe or None, message_id or None).

    Raises:
        ValueError: If tool_name is unknown.
    """
    if tool_name == "save_memory":
        result, recipe = _handle_save_memory(supabase, user_id, args["content"])
        return result, recipe, None

    if tool_name == "submit_feature_request":
        result, recipe = _handle_feature_request(supabase, user_id, args["description"])
        return result, recipe, None

    if tool_name == "find_contact":
        response = (
            supabase.table("user_contacts")
            .select("email, display_name, frequency")
            .eq("user_id", user_id)
            .execute()
        )
        contacts = cast(list[dict[str, Any]], response.data or [])
        matches = rank_contacts(args["name"], contacts)
        return (
            {"matches": [{"email": m.email, "display_name": m.display_name, "score": m.score} for m in matches]},
            None,
            None,
        )

    if tool_name == "what_can_you_do":
        return ({"markdown": CAPABILITIES_MARKDOWN}, None, None)

    if tool_name == "get_newsletter_summary":
        result = _handle_get_newsletter_summary(supabase, user_id, args)
        return result, None, None

    if tool_name == "set_newsletter_config":
        result = _handle_set_newsletter_config(supabase, user_id, args)
        return result, None, None

    raise ValueError(f"Unknown tool: {tool_name}")


def _dispatch_undo(
    recipe: UndoRecipe,
    email_ctx: EmailClientContext,
    supabase: Client,
) -> None:
    """Dispatch an undo operation based on the undo recipe.

    Args:
        recipe: The undo recipe describing what to reverse.
        email_ctx: Provider-aware email client context.
        supabase: Supabase client (for memory/feature request undos).

    Raises:
        ValueError: If the undo operation is unknown.
    """
    # Unipile-specific undo operations
    if recipe.operation == "unipile_move_email":
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(
                unipile_client.undo_move_email(
                    account_id=recipe.params["account_id"],
                    email_id=recipe.params["email_id"],
                    to_folders=recipe.params["to_folders"],
                    rfc_message_id=recipe.params.get("rfc_message_id"),
                )
            )
        finally:
            loop.close()
        return

    if recipe.operation == "unipile_delete_draft":
        loop = asyncio.new_event_loop()
        try:
            account_id = recipe.params["account_id"]
            loop.run_until_complete(
                unipile_client._request("DELETE", f"/api/v1/emails/{recipe.params['draft_id']}", params={"account_id": account_id})
            )
        finally:
            loop.close()
        return

    # IMAP-based undo operations (custom accounts)
    if recipe.operation == "move_email":
        if email_ctx.connection_type != "imap_smtp" or email_ctx.imap_holder is None:
            raise RuntimeError("IMAP holder required for move_email undo")
        imap_holder = email_ctx.imap_holder
        config: ImapConfig = imap_holder["config"]

        if "message_id" in recipe.params:
            email_client.with_reconnect(
                imap_holder, config,
                lambda c: email_client.move_email(
                    c,
                    recipe.params["message_id"],
                    recipe.params["from"],
                    recipe.params["to"],
                ),
            )
        elif "email_id" in recipe.params:
            email_client.with_reconnect(
                imap_holder, config,
                lambda c: _move_email_by_uid(
                    c,
                    recipe.params["email_id"],
                    recipe.params["from"],
                    recipe.params["to"],
                ),
            )
        else:
            raise ValueError("move_email undo recipe missing both message_id and email_id")
        return

    if recipe.operation == "delete_draft":
        if email_ctx.connection_type != "imap_smtp" or email_ctx.imap_holder is None:
            raise RuntimeError("IMAP holder required for delete_draft undo")
        imap_holder = email_ctx.imap_holder
        config = imap_holder["config"]
        email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.delete_draft(c, recipe.params["draft_uid"]),
        )
        return

    if recipe.operation == "delete_memory":
        response = (
            supabase.table("user_memory")
            .delete()
            .eq("id", recipe.params["id"])
            .execute()
        )
        if not response.data:
            raise RuntimeError(f"Failed to delete memory: {recipe.params['id']}")
        return

    if recipe.operation == "delete_feature_request":
        response = (
            supabase.table("feature_requests")
            .delete()
            .eq("id", recipe.params["id"])
            .execute()
        )
        if not response.data:
            raise RuntimeError(f"Failed to delete feature request: {recipe.params['id']}")
        return

    raise ValueError(f"Unknown undo operation: {recipe.operation}")


def _handle_save_memory(
    supabase: Client, user_id: str, content: str
) -> tuple[dict[str, Any], UndoRecipe]:
    """Handle the save_memory tool -- insert a new row into user_memory.

    Args:
        supabase: Supabase client.
        user_id: The user ID.
        content: Markdown content to remember.

    Returns:
        Tuple of (result dict, UndoRecipe).

    Raises:
        RuntimeError: If the database insert fails.
    """
    response = (
        supabase.table("user_memory")
        .insert({"user_id": user_id, "content": content})
        .execute()
    )

    if not response.data:
        raise RuntimeError("Failed to save memory: no data returned")

    data = cast(list[dict[str, Any]], response.data)
    memory_id = data[0]["id"]

    return (
        {"saved": True, "id": memory_id},
        UndoRecipe(operation="delete_memory", params={"id": memory_id}),
    )


def _handle_feature_request(
    supabase: Client, user_id: str, description: str
) -> tuple[dict[str, Any], UndoRecipe]:
    """Handle the submit_feature_request tool -- insert into feature_requests table.

    Args:
        supabase: Supabase client.
        user_id: The user ID.
        description: Feature request description.

    Returns:
        Tuple of (result dict, UndoRecipe).

    Raises:
        RuntimeError: If the database insert fails.
    """
    response = (
        supabase.table("feature_requests")
        .insert({"user_id": user_id, "description": description, "source": "voice"})
        .execute()
    )

    if not response.data:
        raise RuntimeError("Failed to submit feature request: no data returned")

    data = cast(list[dict[str, Any]], response.data)
    request_id = data[0]["id"]

    return (
        {"submitted": True, "id": request_id},
        UndoRecipe(operation="delete_feature_request", params={"id": request_id}),
    )


def _fetch_pending_email_ids(session_id: str, supabase: Client) -> set[str]:
    """Query the actions table for pending/approved delete and archive actions in a session.

    Selects the arguments column and extracts email_id client-side.

    Args:
        session_id: The session to query.
        supabase: Supabase client for DB operations.

    Returns:
        Set of email_id strings that have pending removal actions.
    """
    response = (
        supabase.table("actions")
        .select("arguments")
        .eq("session_id", session_id)
        .in_("tool_name", ["delete_email", "archive_email", "move_to_folder"])
        .in_("status", ["pending", "approved"])
        .execute()
    )

    rows = cast(list[dict[str, Any]], response.data or [])
    return {r["arguments"]["email_id"] for r in rows}


def _fetch_queued_sends(session_id: str, supabase: Client) -> list[QueuedSend]:
    """Query the actions table for pending/approved send_email actions in a session.

    Selects arguments and status columns, extracts to/subject client-side.

    Args:
        session_id: The session to query.
        supabase: Supabase client for DB operations.

    Returns:
        List of QueuedSend objects with to, subject, and status.
    """
    response = (
        supabase.table("actions")
        .select("arguments, status")
        .eq("session_id", session_id)
        .eq("tool_name", "send_email")
        .in_("status", ["pending", "approved"])
        .execute()
    )

    rows = cast(list[dict[str, Any]], response.data or [])
    return [
        QueuedSend(
            to=r["arguments"]["to"],
            subject=r["arguments"]["subject"],
            status=r["status"],
        )
        for r in rows
    ]


def _format_queued_sends(sends: list[QueuedSend]) -> str:
    """Format queued outgoing emails as a markdown section.

    Returns an empty string if the list is empty.

    Args:
        sends: List of QueuedSend objects to format.

    Returns:
        Markdown string with the queued outgoing section.
    """
    if not sends:
        return ""

    lines = [f"## Queued Outgoing ({len(sends)} emails)", ""]

    for send in sends:
        lines.append(f"- **To:** {send.to} | **Subject:** {send.subject}")
        lines.append("  *Status: Awaiting approval*")
        lines.append("")

    return "\n".join(lines)


def _move_email_by_uid(
    client: Any,
    email_id: str,
    from_folder: str,
    to_folder: str,
) -> None:
    """Move an email by UID (legacy backwards-compat path for old undo recipes).

    Args:
        client: Connected IMAPClient.
        email_id: The UID of the email.
        from_folder: Source folder.
        to_folder: Destination folder.
    """
    client.select_folder(from_folder)
    client.move([int(email_id)], to_folder)


def _resolve_user_timezone(supabase: Client, user_id: str) -> str:
    """Resolve the user's IANA timezone using the same chain as session.py.

    Resolution order:
    1. call_schedule.timezone (explicit IANA timezone)
    2. _timezone_from_country_code(phone.countryCode) (fallback)
    3. "UTC" (last resort)

    Args:
        supabase: Supabase client for DB operations.
        user_id: The user ID to resolve timezone for.

    Returns:
        IANA timezone string.
    """
    response = (
        supabase.table("user_settings")
        .select("call_schedule, phone")
        .eq("user_id", user_id)
        .single()
        .execute()
    )

    if response.data is None:
        return "UTC"

    settings = cast(dict[str, Any], response.data)

    call_schedule = settings.get("call_schedule")
    user_timezone: str | None = call_schedule.get("timezone") if call_schedule else None
    if user_timezone is None:
        phone = settings.get("phone")
        if phone and phone.get("countryCode"):
            user_timezone = _timezone_from_country_code(phone["countryCode"])

    return user_timezone or "UTC"


def _handle_get_newsletter_summary(
    supabase: Client,
    user_id: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Handle the get_newsletter_summary tool.

    Resolves the target date from the optional "date" arg (defaults to yesterday),
    validates it, and fetches the newsletter summary. If no summary exists, returns
    an on_demand_task payload so the pipeline can trigger background generation.

    Args:
        supabase: Supabase client for DB operations.
        user_id: The user ID.
        args: Tool arguments. Optional key "date" (YYYY-MM-DD string).

    Returns:
        Dict with summary, email_count, and listened_already -- or an
        on_demand_task dict when no summary exists yet.
    """
    # Resolve user timezone
    user_timezone = _resolve_user_timezone(supabase, user_id)
    tz = ZoneInfo(user_timezone)
    now_local = datetime.now(tz)
    today = now_local.date()
    yesterday = (now_local - timedelta(days=1)).date()

    # Parse and validate the target date
    date_str = args.get("date")
    if date_str:
        try:
            target_date = date_type.fromisoformat(date_str)
        except ValueError:
            return {"error": f"Invalid date format: '{date_str}'. Expected YYYY-MM-DD."}

        if target_date > today:
            return {"error": f"Cannot retrieve a summary for a future date ({date_str})."}

        max_age = today - timedelta(days=7)
        if target_date < max_age:
            return {"error": f"Date {date_str} is older than 7 days. Only the last 7 days are available."}
    else:
        target_date = yesterday

    # Query newsletter_summaries for the target date
    response = (
        supabase.table("newsletter_summaries")
        .select("id, summary, email_count, listened")
        .eq("user_id", user_id)
        .eq("summary_date", target_date.isoformat())
        .execute()
    )

    rows = cast(list[dict[str, Any]], response.data or [])
    if not rows:
        return {
            "message": (
                "No summary found for that date. "
                "I'm generating one now -- ask again in about a minute."
            ),
            "generating": True,
            "on_demand_task": {
                "user_id": user_id,
                "target_date": target_date.isoformat(),
            },
        }

    row = rows[0]
    listened_already = bool(row["listened"])

    # Mark as listened if not already
    if not listened_already:
        supabase.table("newsletter_summaries").update({
            "listened": True,
            "listened_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", row["id"]).execute()

    return {
        "summary": row["summary"],
        "email_count": row["email_count"],
        "listened_already": listened_already,
    }


def _handle_set_newsletter_config(
    supabase: Client,
    user_id: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Handle the set_newsletter_config tool.

    Reads the current newsletter_config from user_settings, merges with
    provided args, and writes back. Initializes a base config if the
    current value is null.

    Args:
        supabase: Supabase client for DB operations.
        user_id: The user ID.
        args: Tool arguments (enabled, newsletters, summary_prompt -- all optional).

    Returns:
        Dict with updated=True and the new config.
    """
    # Read current newsletter_config
    response = (
        supabase.table("user_settings")
        .select("newsletter_config")
        .eq("user_id", user_id)
        .single()
        .execute()
    )

    if response.data is None:
        raise RuntimeError(f"User settings not found for {user_id}")

    settings = cast(dict[str, Any], response.data)
    current_config = cast(dict[str, Any] | None, settings.get("newsletter_config"))

    # Initialize base config if null
    if current_config is None:
        current_config = {"enabled": False, "newsletters": [], "summary_prompt": None}

    # Merge provided args into current config
    if "enabled" in args:
        current_config["enabled"] = args["enabled"]
    if "newsletters" in args:
        current_config["newsletters"] = args["newsletters"]
    if "summary_prompt" in args:
        current_config["summary_prompt"] = args["summary_prompt"]

    # Write back
    supabase.table("user_settings").update({
        "newsletter_config": current_config,
    }).eq("user_id", user_id).execute()

    return {"updated": True, "config": current_config}
