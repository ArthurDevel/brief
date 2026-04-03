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
from datetime import datetime, timezone
from typing import Any, cast

from supabase import Client

from src.session import ImapConfig, SmtpConfig
from src.tools.classification import classify_action
from src.tools.contact_matcher import rank_contacts
from src.tools.definitions import CAPABILITIES_MARKDOWN
from src.tools import email_client
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
    imap_holder: dict[str, Any],
    smtp_config: SmtpConfig,
    supabase: Client,
) -> ActionResult:
    """Main entry point for processing a tool call from the voice pipeline.

    Classifies the action, then either queues as pending or executes immediately.
    Writes the action to the DB in both cases.

    Args:
        input: The tool call input (user_id, session_id, tool_name, arguments).
        user_config: User's per-tool classification overrides.
        imap_holder: Mutable dict {"client": IMAPClient, "config": ImapConfig}
            so with_reconnect can swap the client on failure.
        smtp_config: SMTP configuration for sending emails.
        supabase: Supabase client for DB operations.

    Returns:
        ActionResult with the outcome.
    """
    # Intercept batch tools before the normal classify/dispatch flow
    if input.tool_name == "batch_archive_emails":
        return _handle_batch_archive(input, imap_holder, smtp_config, supabase)
    if input.tool_name == "batch_delete_emails":
        return _handle_batch_delete(input, supabase)

    classification = classify_action(input.tool_name, user_config)
    requires_approval = classification == "mutating_queued"

    if requires_approval:
        return _insert_pending_action(input, supabase)

    # Execute immediately (read_only or mutating_auto)
    return _execute_and_store(input, imap_holder, smtp_config, supabase)


def execute_action(
    action_id: str,
    supabase: Client,
    imap_holder: dict[str, Any],
    smtp_config: SmtpConfig,
) -> ActionResult:
    """Execute a pending/approved action by ID (called by dashboard approve flow).

    Loads action row, dispatches tool, writes result + undo_recipe.

    Args:
        action_id: The action row ID to execute.
        supabase: Supabase client for DB operations.
        imap_holder: Mutable dict {"client": IMAPClient, "config": ImapConfig}.
        smtp_config: SMTP configuration for sending emails.

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
        imap_holder=imap_holder,
        smtp_config=smtp_config,
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
    imap_holder: dict[str, Any],
) -> UndoResult:
    """Reverse an executed action using its stored undo recipe.

    Checks deadline, dispatches reverse operation, sets status to "undone".

    Args:
        action_id: The action row ID to undo.
        supabase: Supabase client for DB operations.
        imap_holder: Mutable dict {"client": IMAPClient, "config": ImapConfig}.

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
    _dispatch_undo(recipe, imap_holder, supabase)

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
    imap_holder: dict[str, Any],
    smtp_config: SmtpConfig,
    supabase: Client,
) -> ActionResult:
    """Fan out a batch archive request into individual archive_email actions.

    Loops sequentially over each email_id, calling _execute_and_store for each.
    Each iteration constructs a fresh ActionInput with a fresh arguments dict
    because _execute_and_store mutates input.arguments in-place (adds message_id).

    Args:
        input: The batch action input containing email_ids in arguments.
        imap_holder: Mutable dict {"client": IMAPClient, "config": ImapConfig}.
        smtp_config: SMTP configuration for sending emails.
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
            result = _execute_and_store(individual_input, imap_holder, smtp_config, supabase)
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
    imap_holder: dict[str, Any],
    smtp_config: SmtpConfig,
    supabase: Client,
) -> ActionResult:
    """Dispatch a tool call and store the result + undo recipe in the DB.

    Args:
        input: The action input.
        imap_holder: Mutable dict {"client": IMAPClient, "config": ImapConfig}.
        smtp_config: SMTP configuration.
        supabase: Supabase client.

    Returns:
        ActionResult with executed status.

    Raises:
        RuntimeError: If the database insert fails.
    """
    result, undo_recipe, message_id = _dispatch_tool(
        tool_name=input.tool_name,
        args=input.arguments,
        imap_holder=imap_holder,
        smtp_config=smtp_config,
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
    imap_holder: dict[str, Any],
    smtp_config: SmtpConfig,
    supabase: Client,
    user_id: str,
    session_id: str | None = None,
) -> tuple[dict[str, Any], UndoRecipe | None, str | None]:
    """Dispatch a tool call to the appropriate handler.

    Routes to email_client functions or Supabase inserts for memory/feature requests.
    IMAP operations use with_reconnect for connection resilience.

    Args:
        tool_name: The tool to execute.
        args: The tool arguments.
        imap_holder: Mutable dict {"client": IMAPClient, "config": ImapConfig}.
        smtp_config: SMTP configuration.
        supabase: Supabase client.
        user_id: The user ID (for memory/feature request operations).
        session_id: The session ID for filtering pending actions, or None to skip filtering.

    Returns:
        Tuple of (result dict, UndoRecipe or None, message_id or None).
        message_id is only returned for archive_email and delete_email.

    Raises:
        ValueError: If tool_name is unknown.
    """
    config: ImapConfig = imap_holder["config"]

    if tool_name == "list_inbox":
        limit = args.get("limit", 20)

        # Filter out emails with pending removal actions in this session
        if session_id is not None:
            pending_ids = _fetch_pending_email_ids(session_id, supabase)
            # Overfetch to compensate for filtered-out emails
            overfetch_limit = limit + len(pending_ids)
            emails = email_client.with_reconnect(
                imap_holder, config,
                lambda c: email_client.list_inbox(c, overfetch_limit),
            )
            filtered = [e for e in emails if e.id not in pending_ids][:limit]
            markdown = format_email_summaries(filtered, "Inbox")

            # Append queued outgoing emails if any exist
            sends = _fetch_queued_sends(session_id, supabase)
            if sends:
                markdown += "\n\n" + _format_queued_sends(sends)

            return {"markdown": markdown}, None, None

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

    if tool_name == "list_folders":
        folders = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.list_folders(c),
        )
        return {"markdown": format_folders(folders)}, None, None

    if tool_name == "move_to_folder":
        source_folder = args.get("source_folder", "INBOX")
        recipe_data, message_id = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.move_email_to_folder(
                c, args["email_id"], args["folder"], source_folder
            ),
        )
        return {"moved": True}, UndoRecipe(**recipe_data), message_id

    if tool_name == "what_can_you_do":
        return ({"markdown": CAPABILITIES_MARKDOWN}, None, None)

    raise ValueError(f"Unknown tool: {tool_name}")


def _dispatch_undo(
    recipe: UndoRecipe,
    imap_holder: dict[str, Any],
    supabase: Client,
) -> None:
    """Dispatch an undo operation based on the undo recipe.

    Args:
        recipe: The undo recipe describing what to reverse.
        imap_holder: Mutable dict {"client": IMAPClient, "config": ImapConfig}.
        supabase: Supabase client (for memory/feature request undos).

    Raises:
        ValueError: If the undo operation is unknown.
    """
    config: ImapConfig = imap_holder["config"]

    if recipe.operation == "move_email":
        if "message_id" in recipe.params:
            # New path: search by Message-ID header for reliable undo
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
            # Backwards-compat: old recipes stored UID as email_id.
            # Use direct UID-based move since move_email now expects Message-ID.
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
