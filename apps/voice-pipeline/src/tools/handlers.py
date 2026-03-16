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
from typing import Any

from supabase import Client

from src.session import ImapConfig, SmtpConfig
from src.tools.classification import classify_action
from src.tools import email_client

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

    action = response.data

    if action["status"] not in ("pending", "approved"):
        raise RuntimeError(
            f'Action {action_id} cannot be executed -- status is "{action["status"]}"'
        )

    # Execute the tool
    result, undo_recipe = _dispatch_tool(
        tool_name=action["tool_name"],
        args=action["arguments"],
        imap_holder=imap_holder,
        smtp_config=smtp_config,
        supabase=supabase,
        user_id=action["user_id"],
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

    action = response.data

    if action["status"] != "executed":
        return UndoResult(
            success=False,
            message=f'Action {action_id} cannot be undone -- status is "{action["status"]}"',
        )

    undo_recipe_data = action.get("undo_recipe")
    if not undo_recipe_data:
        return UndoResult(success=False, message=f"Action {action_id} is not undoable")

    recipe = UndoRecipe(
        operation=undo_recipe_data["operation"],
        params=undo_recipe_data["params"],
    )

    # Check undo deadline
    if action.get("undo_deadline"):
        deadline = datetime.fromisoformat(action["undo_deadline"])
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
        .select("id")
        .execute()
    )

    if not response.data:
        raise RuntimeError("Failed to insert pending action: no data returned")

    action_id = response.data[0]["id"]

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
    result, undo_recipe = _dispatch_tool(
        tool_name=input.tool_name,
        args=input.arguments,
        imap_holder=imap_holder,
        smtp_config=smtp_config,
        supabase=supabase,
        user_id=input.user_id,
    )

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
        .select("id")
        .execute()
    )

    if not response.data:
        raise RuntimeError("Failed to insert executed action: no data returned")

    action_id = response.data[0]["id"]

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
) -> tuple[dict[str, Any], UndoRecipe | None]:
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

    Returns:
        Tuple of (result dict, UndoRecipe or None).

    Raises:
        ValueError: If tool_name is unknown.
    """
    config: ImapConfig = imap_holder["config"]

    if tool_name == "list_inbox":
        limit = args.get("limit", 5)
        emails = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.list_inbox(c, limit),
        )
        return {"emails": [_email_summary_to_dict(e) for e in emails]}, None

    if tool_name == "read_email":
        result = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.read_email(c, args["email_id"]),
        )
        return {"email": _email_to_dict(result)}, None

    if tool_name == "search_emails":
        emails = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.search_emails(c, args["query"]),
        )
        return {"emails": [_email_summary_to_dict(e) for e in emails]}, None

    if tool_name == "mark_as_read":
        email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.mark_as_read(c, args["email_id"]),
        )
        return {"marked": True}, None

    if tool_name == "archive_email":
        source_folder = args.get("source_folder", "INBOX")
        recipe_data = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.archive_email(c, args["email_id"], source_folder),
        )
        return {"archived": True}, UndoRecipe(**recipe_data)

    if tool_name == "delete_email":
        source_folder = args.get("source_folder", "INBOX")
        recipe_data = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.delete_email(c, args["email_id"], source_folder),
        )
        return {"deleted": True}, UndoRecipe(**recipe_data)

    if tool_name == "draft_email":
        recipe_data = email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.save_draft(c, args["to"], args["subject"], args["body"]),
        )
        return {"drafted": True, "draft_uid": recipe_data["params"]["draft_uid"]}, UndoRecipe(**recipe_data)

    if tool_name == "send_email":
        # send_email can send a draft by draft_id, or a new email with to/subject/body
        if args.get("draft_id"):
            email_client.with_reconnect(
                imap_holder, config,
                lambda c: email_client.send_draft(c, smtp_config, args["draft_id"]),
            )
        else:
            # Run async SMTP send in the current event loop
            asyncio.get_event_loop().run_until_complete(
                email_client.send_email(smtp_config, args["to"], args["subject"], args["body"])
            )
        return {"sent": True}, None

    if tool_name == "save_memory":
        return _handle_save_memory(supabase, user_id, args["content"])

    if tool_name == "submit_feature_request":
        return _handle_feature_request(supabase, user_id, args["description"])

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
        email_client.with_reconnect(
            imap_holder, config,
            lambda c: email_client.move_email(
                c,
                recipe.params["email_id"],
                recipe.params["from"],
                recipe.params["to"],
            ),
        )
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
        .select("id")
        .execute()
    )

    if not response.data:
        raise RuntimeError("Failed to save memory: no data returned")

    memory_id = response.data[0]["id"]

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
        .select("id")
        .execute()
    )

    if not response.data:
        raise RuntimeError("Failed to submit feature request: no data returned")

    request_id = response.data[0]["id"]

    return (
        {"submitted": True, "id": request_id},
        UndoRecipe(operation="delete_feature_request", params={"id": request_id}),
    )


def _email_summary_to_dict(summary: email_client.EmailSummary) -> dict[str, Any]:
    """Convert an EmailSummary dataclass to a plain dict for JSON serialization.

    Args:
        summary: EmailSummary instance.

    Returns:
        Dict representation.
    """
    return {
        "id": summary.id,
        "from": summary.from_addr,
        "subject": summary.subject,
        "snippet": summary.snippet,
        "date": summary.date,
    }


def _email_to_dict(em: email_client.Email) -> dict[str, Any]:
    """Convert an Email dataclass to a plain dict for JSON serialization.

    Args:
        em: Email instance.

    Returns:
        Dict representation.
    """
    return {
        "id": em.id,
        "from": em.from_addr,
        "to": em.to,
        "subject": em.subject,
        "body": em.body,
        "date": em.date,
        "is_read": em.is_read,
    }
