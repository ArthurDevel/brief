"""
Tool JSON schema definitions for OpenAI function-calling format.

Port of packages/tools/src/definitions.ts.

Each definition describes a tool the LLM can call. These are schema-only
(no handlers) -- handlers live in handlers.py and email_client.py.

- Define all 13 tool schemas (list_inbox, read_email, read_thread,
  search_emails, mark_as_read, draft_email, delete_email, archive_email,
  send_email, batch_archive_emails, batch_delete_emails, save_memory,
  submit_feature_request)
- Export them as a list for LLM service configuration
"""

from __future__ import annotations


# ============================================================================
# TOOL DEFINITIONS
# ============================================================================

def get_tool_definitions() -> list[dict]:
    """Return all 13 tool schemas as Python dicts in OpenAI function-calling format.

    Returns:
        List of tool definition dicts, each with "type", "function" containing
        "name", "description", and "parameters".
    """
    return [
        {
            "type": "function",
            "function": {
                "name": "list_inbox",
                "description": (
                    "List recent emails in the user's inbox. "
                    "Returns sender, subject, snippet, and date for each email."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {
                            "type": "number",
                            "description": "Maximum number of emails to return. Defaults to 5.",
                        },
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "read_email",
                "description": "Read the full content of a specific email by its ID.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "The ID of the email to read.",
                        },
                    },
                    "required": ["email_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "read_thread",
                "description": (
                    "Read an entire email thread/conversation by the ID of any email "
                    "in the thread. Returns all messages including the user's sent "
                    "replies, in chronological order. Use this when the user asks "
                    "about a thread, conversation, or their reply to an email."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "The ID of any email in the thread.",
                        },
                    },
                    "required": ["email_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "search_emails",
                "description": "Search emails by query string. Searches subject, sender, and body.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query to match against emails.",
                        },
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "mark_as_read",
                "description": "Mark an email as read by its ID.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "The ID of the email to mark as read.",
                        },
                    },
                    "required": ["email_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "draft_email",
                "description": (
                    "Create a new email draft. "
                    "Returns a draft ID that can be used to send it later."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "to": {
                            "type": "string",
                            "description": "Recipient email address.",
                        },
                        "subject": {
                            "type": "string",
                            "description": "Email subject line.",
                        },
                        "body": {
                            "type": "string",
                            "description": "Email body text.",
                        },
                    },
                    "required": ["to", "subject", "body"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "delete_email",
                "description": "Delete an email by its ID. Moves it to the Trash folder.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "The ID of the email to delete.",
                        },
                    },
                    "required": ["email_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "archive_email",
                "description": "Archive an email by its ID. Moves it out of the inbox.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "The ID of the email to archive.",
                        },
                    },
                    "required": ["email_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "send_email",
                "description": (
                    "Send an email. Can send an existing draft by draft_id, "
                    "or send a new email directly with to, subject, and body."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "draft_id": {
                            "type": "string",
                            "description": "The draft ID to send. If provided, sends the existing draft.",
                        },
                        "to": {
                            "type": "string",
                            "description": "Recipient email address (for new emails).",
                        },
                        "subject": {
                            "type": "string",
                            "description": "Email subject (for new emails).",
                        },
                        "body": {
                            "type": "string",
                            "description": "Email body (for new emails).",
                        },
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "batch_archive_emails",
                "description": (
                    "Archive multiple emails at once by their IDs. "
                    "Moves each email out of the inbox."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "email_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Array of email IDs to archive.",
                        },
                    },
                    "required": ["email_ids"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "batch_delete_emails",
                "description": (
                    "Delete multiple emails at once by their IDs. "
                    "Moves each email to the Trash folder."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "email_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Array of email IDs to delete.",
                        },
                    },
                    "required": ["email_ids"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "save_memory",
                "description": (
                    "Save a memory entry about the user. Use this to remember preferences, "
                    "names, or any info the user wants persisted across calls."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": {
                            "type": "string",
                            "description": "Markdown content to remember about the user.",
                        },
                    },
                    "required": ["content"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "submit_feature_request",
                "description": (
                    "Submit a feature request from the user. "
                    "Stores it for the development team to review."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "description": {
                            "type": "string",
                            "description": "Description of the feature the user wants.",
                        },
                    },
                    "required": ["description"],
                },
            },
        },
    ]
