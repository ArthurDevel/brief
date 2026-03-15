/**
 * Tool JSON schema definitions for OpenAI Realtime API session.update.
 *
 * Each definition describes a tool the model can call. These are schema-only
 * (no handlers) -- handlers live in action-queue.ts and the email package.
 *
 * Responsibilities:
 * - Define all 10 tool schemas (list_inbox, read_email, search_emails,
 *   mark_as_read, draft_email, delete_email, archive_email, send_email,
 *   save_memory, submit_feature_request)
 * - Export them as an array for session.update
 */

// ============================================================================
// TYPES
// ============================================================================

/** JSON Schema definition for a single tool sent to OpenAI. */
export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const toolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    name: "list_inbox",
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
    name: "search_emails",
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
    description:
      "Send an email. Can send an existing draft by draft_id, or send a new email directly with to, subject, and body.",
    parameters: {
      type: "object",
      properties: {
        draft_id: {
          type: "string",
          description: "The draft ID to send. If provided, sends the existing draft.",
        },
        to: { type: "string", description: "Recipient email address (for new emails)." },
        subject: { type: "string", description: "Email subject (for new emails)." },
        body: { type: "string", description: "Email body (for new emails)." },
      },
    },
  },

  {
    type: "function",
    name: "save_memory",
    description:
      "Save a key-value pair to the user's persistent memory. Use this to remember preferences, names, or any info the user wants persisted across calls.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "The memory key (e.g. 'preferred_name', 'boss_email')." },
        value: { type: "string", description: "The value to store." },
      },
      required: ["key", "value"],
    },
  },

  {
    type: "function",
    name: "submit_feature_request",
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
];
