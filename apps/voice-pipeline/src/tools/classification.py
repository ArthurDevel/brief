"""
Default tool classification logic.

Port of packages/tools/src/classification.ts.

Determines whether a tool call is read-only, auto-executed, or queued
for manual approval based on the tool name and user overrides.

- Map each tool name to its default ActionClassification
- Provide classify_action() with user override support
- send_email is always mutating_queued (cannot be overridden)
"""

from __future__ import annotations


# ============================================================================
# CONSTANTS
# ============================================================================

DEFAULT_CLASSIFICATIONS: dict[str, str] = {
    "list_inbox": "read_only",
    "read_email": "read_only",
    "read_thread": "read_only",
    "search_emails": "read_only",
    "save_memory": "read_only",
    "submit_feature_request": "read_only",
    "mark_as_read": "mutating_auto",
    "archive_email": "mutating_auto",
    "draft_email": "mutating_auto",
    "batch_archive_emails": "mutating_auto",
    "batch_delete_emails": "mutating_queued",
    "delete_email": "mutating_queued",
    "send_email": "mutating_queued",
}


# ============================================================================
# MAIN LOGIC
# ============================================================================

def classify_action(tool_name: str, user_config: dict[str, str]) -> str:
    """Return the effective classification for a tool call.

    send_email is always "mutating_queued" regardless of user config.
    For other tools, checks user overrides first, then falls back to defaults.

    Args:
        tool_name: The tool being called.
        user_config: User's per-tool classification overrides (tool_name -> classification).

    Returns:
        One of "read_only", "mutating_auto", or "mutating_queued".

    Raises:
        ValueError: If tool_name is not a known tool.
    """
    # send_email is always queued -- cannot be overridden
    if tool_name == "send_email":
        return "mutating_queued"

    # Check user overrides first
    if tool_name in user_config:
        return user_config[tool_name]

    # Fall back to defaults
    if tool_name not in DEFAULT_CLASSIFICATIONS:
        raise ValueError(f"Unknown tool: {tool_name}")

    return DEFAULT_CLASSIFICATIONS[tool_name]
