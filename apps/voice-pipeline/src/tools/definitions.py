"""
Tool JSON schema definitions for OpenAI function-calling format.

Port of packages/tools/src/definitions.ts.

Each definition describes a tool the LLM can call. These are schema-only
(no handlers) -- handlers live in handlers.py and email_client.py.

- Define all 15 tool schemas (list_inbox, read_email, read_thread,
  search_emails, mark_as_read, draft_email, delete_email, archive_email,
  send_email, batch_archive_emails, batch_delete_emails, save_memory,
  submit_feature_request, list_folders, move_to_folder)
- Export them as a list for LLM service configuration
"""

from __future__ import annotations


# ============================================================================
# CONSTANTS
# ============================================================================

# NOTE: keep in sync with packages/tools/src/definitions.ts
CAPABILITIES_MARKDOWN = """Here is what I can help you with:

**Reading emails** -- check your inbox, search for specific emails, and read full threads or individual messages.

**Managing emails** -- archive, delete, label, move to folders, and mark emails as read.

**Sending emails** -- compose and send new emails, reply to existing conversations, or save drafts for later.

**Finding contacts** -- look up people by name so you can quickly email them.

**Summarizing newsletters** -- I can give you a quick summary of your newsletter emails.

**Memory** -- I can save your preferences and details you tell me, so I remember them next time.

**Feature requests** -- if there is something you wish I could do, just tell me and I will pass it along to the team.
"""


# ============================================================================
# TOOL DEFINITIONS
# ============================================================================

def get_tool_definitions() -> list[dict]:
    """Return all 15 tool schemas as Python dicts in OpenAI function-calling format.

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
                            "description": "Maximum number of emails to return. Defaults to 20.",
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
                "description": (
                    "Search emails via IMAP. Supports Gmail-style operators: "
                    "from:, to:, subject:, before:YYYY-MM-DD, after:YYYY-MM-DD, "
                    "has:attachment, is:unread. Plain keywords search subject and sender. "
                    "Multiple terms are ANDed together."
                ),
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
                "description": "Send an email with the given recipient, subject, and body.",
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
                "name": "reply_email",
                "description": (
                    "Reply to an existing email by its ID. The email_id must come from "
                    "a prior read_email or read_thread result. The reply is threaded "
                    "correctly so it appears in the same conversation."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": (
                                "The ID of the email to reply to. Must come from a prior "
                                "read_email or read_thread result."
                            ),
                        },
                        "body": {
                            "type": "string",
                            "description": "The reply body text.",
                        },
                        "reply_all": {
                            "type": "boolean",
                            "description": "Whether to reply to all recipients. Defaults to false.",
                        },
                    },
                    "required": ["email_id", "body"],
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
        {
            "type": "function",
            "function": {
                "name": "find_contact",
                "description": (
                    "Look up a contact by name. Returns ranked matches with email "
                    "addresses. Use this when the user asks to email someone by name."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "The name of the contact to look up.",
                        },
                    },
                    "required": ["name"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_folders",
                "description": "List all available email folders.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "move_to_folder",
                "description": (
                    "Move an email to a specified folder. "
                    "On Gmail, this is equivalent to applying a label."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "The ID of the email to move.",
                        },
                        "folder": {
                            "type": "string",
                            "description": "The target folder to move the email to.",
                        },
                        "source_folder": {
                            "type": "string",
                            "description": "The folder the email is currently in. Defaults to INBOX.",
                        },
                    },
                    "required": ["email_id", "folder"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "what_can_you_do",
                "description": "Returns a summary of all capabilities this assistant has.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                },
            },
        },
    ]
