/**
 * Tool JSON schema definitions for OpenAI Realtime API session.update.
 *
 * Each definition describes a tool the model can call. These are schema-only
 * (no handlers) -- handlers live in action-queue.ts and the email package.
 *
 * Responsibilities:
 * - Define all 16 tool schemas (list_inbox, read_email, read_thread,
 *   search_emails, mark_as_read, draft_email, delete_email, archive_email,
 *   send_email, reply_email, batch_archive_emails, batch_delete_emails,
 *   list_folders, move_to_folder, save_memory, submit_feature_request)
 * - Export them as an array for session.update
 */

// ============================================================================
// TYPES
// ============================================================================

/** JSON Schema definition for a single tool sent to OpenAI. */
export interface ToolDefinition {
  type: "function";
  name: string;
  label: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string; items?: { type: string } }>;
    required?: string[];
  };
}

// ============================================================================
// CAPABILITIES MARKDOWN
// ============================================================================

// NOTE: keep in sync with apps/voice-pipeline/src/tools/definitions.py
/** Markdown summary of all capabilities this assistant has. */
export const CAPABILITIES_MARKDOWN = `Here is what I can help you with:

**Reading emails** -- check your inbox, search for specific emails, and read full threads or individual messages.

**Managing emails** -- archive, delete, label, move to folders, and mark emails as read.

**Sending emails** -- compose and send new emails, reply to existing conversations, or save drafts for later.

**Finding contacts** -- look up people by name so you can quickly email them.

**Daily newsletter recap** -- I can give you a daily summary of all the newsletters you received, so you stay informed without reading each one.

**Memory** -- I can save your preferences and details you tell me, so I remember them next time.

**Feature requests** -- if there is something you wish I could do, just tell me and I will pass it along to the team.
`;

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const toolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    name: "list_inbox",
    label: "List Inbox",
    description:
      "List recent emails in the user's inbox. Returns sender, subject, snippet, and date for each email.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of emails to return. Defaults to 5.",
        },
      },
    },
  },

  {
    type: "function",
    name: "read_email",
    label: "Read Email",
    description: "Read the full content of a specific email by its ID.",
    parameters: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "The ID of the email to read.",
        },
      },
      required: ["email_id"],
    },
  },

  {
    type: "function",
    name: "read_thread",
    label: "Read Thread",
    description:
      "Read an entire email thread/conversation by the ID of any email in the thread. Returns all messages including the user's sent replies, in chronological order. Use this when the user asks about a thread, conversation, or their reply to an email.",
    parameters: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "The ID of any email in the thread.",
        },
      },
      required: ["email_id"],
    },
  },

  {
    type: "function",
    name: "search_emails",
    label: "Search Emails",
    description: "Search emails by query string. Searches subject, sender, and body.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to match against emails.",
        },
      },
      required: ["query"],
    },
  },

  {
    type: "function",
    name: "mark_as_read",
    label: "Mark as Read",
    description: "Mark an email as read by its ID.",
    parameters: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "The ID of the email to mark as read.",
        },
      },
      required: ["email_id"],
    },
  },

  {
    type: "function",
    name: "draft_email",
    label: "Draft Email",
    description: "Create a new email draft. Returns a draft ID that can be used to send it later.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Email subject line." },
        body: { type: "string", description: "Email body text." },
      },
      required: ["to", "subject", "body"],
    },
  },

  {
    type: "function",
    name: "delete_email",
    label: "Delete Email",
    description: "Delete an email by its ID. Moves it to the Trash folder.",
    parameters: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "The ID of the email to delete.",
        },
      },
      required: ["email_id"],
    },
  },

  {
    type: "function",
    name: "archive_email",
    label: "Archive Email",
    description: "Archive an email by its ID. Moves it out of the inbox.",
    parameters: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "The ID of the email to archive.",
        },
      },
      required: ["email_id"],
    },
  },

  {
    type: "function",
    name: "send_email",
    label: "Send Email",
    description: "Send an email with the given recipient, subject, and body.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Email subject line." },
        body: { type: "string", description: "Email body text." },
      },
      required: ["to", "subject", "body"],
    },
  },

  {
    type: "function",
    name: "reply_email",
    label: "Reply to Email",
    description:
      "Reply to an existing email by its ID. The email_id must come from a prior read_email or read_thread result. The reply is threaded correctly so it appears in the same conversation.",
    parameters: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "The ID of the email to reply to. Must come from a prior read_email or read_thread result.",
        },
        body: {
          type: "string",
          description: "The reply body text.",
        },
        reply_all: {
          type: "boolean",
          description: "Whether to reply to all recipients. Defaults to false.",
        },
      },
      required: ["email_id", "body"],
    },
  },

  {
    type: "function",
    name: "batch_archive_emails",
    label: "Archive Multiple Emails",
    description: "Archive multiple emails at once by their IDs. Moves each email out of the inbox.",
    parameters: {
      type: "object",
      properties: {
        email_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of email IDs to archive.",
        },
      },
      required: ["email_ids"],
    },
  },

  {
    type: "function",
    name: "batch_delete_emails",
    label: "Delete Multiple Emails",
    description: "Delete multiple emails at once by their IDs. Moves each email to the Trash folder.",
    parameters: {
      type: "object",
      properties: {
        email_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of email IDs to delete.",
        },
      },
      required: ["email_ids"],
    },
  },

  {
    type: "function",
    name: "list_folders",
    label: "List Folders",
    description: "List all available email folders.",
    parameters: {
      type: "object",
      properties: {},
    },
  },

  {
    type: "function",
    name: "move_to_folder",
    label: "Move to Folder",
    description:
      "Move an email to a specified folder. On Gmail, this is equivalent to applying a label.",
    parameters: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "The ID of the email to move.",
        },
        folder: {
          type: "string",
          description: "The target folder to move the email to.",
        },
        source_folder: {
          type: "string",
          description: "The folder the email is currently in. Defaults to INBOX.",
        },
      },
      required: ["email_id", "folder"],
    },
  },

  {
    type: "function",
    name: "save_memory",
    label: "Save Memory",
    description:
      "Save a memory entry about the user. Use this to remember preferences, names, or any info the user wants persisted across calls.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Markdown content to remember about the user." },
      },
      required: ["content"],
    },
  },

  {
    type: "function",
    name: "submit_feature_request",
    label: "Submit Feature Request",
    description: "Submit a feature request from the user. Stores it for the development team to review.",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Description of the feature the user wants.",
        },
      },
      required: ["description"],
    },
  },
  {
    type: "function",
    name: "what_can_you_do",
    label: "Capabilities",
    description: "Returns a summary of all capabilities this assistant has.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/** Lookup map from tool name to its human-readable label. */
export const TOOL_LABELS: Record<string, string> = Object.fromEntries(
  toolDefinitions.map((t) => [t.name, t.label])
);
