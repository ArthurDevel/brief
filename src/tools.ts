/**
 * Mock email tools for the voice email assistant.
 *
 * Defines 6 tools (list_inbox, read_email, draft_email, delete_email, archive_email, send_email)
 * with hardcoded responses. The model believes it's interacting with a real inbox.
 *
 * - Each tool has a JSON Schema definition (sent to OpenAI) and a handler (executed server-side)
 * - Handlers return JSON strings with fake but realistic data
 */

import type { Tool } from "./types.js";

// ============================================================================
// CONSTANTS -- MOCK DATA
// ============================================================================

const MOCK_EMAILS = [
  {
    id: "email_001",
    from: "sarah.chen@techcorp.com",
    subject: "Q1 Budget Review Meeting",
    snippet: "Hi, can we schedule the Q1 budget review for next Tuesday? I've prepared the...",
    date: "2026-03-11",
    body: "Hi,\n\nCan we schedule the Q1 budget review for next Tuesday at 2 PM? I've prepared the financial summary and identified a few areas where we're over budget. The marketing spend is 15% above projections, but engineering is under by 8%.\n\nPlease confirm if Tuesday works.\n\nBest,\nSarah",
  },
  {
    id: "email_002",
    from: "james.wilson@clientco.io",
    subject: "Re: Proposal Draft v2",
    snippet: "Thanks for sending the updated proposal. I've reviewed it with my team and we have...",
    date: "2026-03-11",
    body: "Thanks for sending the updated proposal. I've reviewed it with my team and we have a few comments:\n\n1. The timeline looks good, but can we add a buffer for the testing phase?\n2. The pricing in Section 3 needs to reflect the 10% volume discount we discussed.\n3. Can you add a section on data migration?\n\nOtherwise, we're happy with the direction. Let me know when v3 is ready.\n\nBest regards,\nJames",
  },
  {
    id: "email_003",
    from: "notifications@github.com",
    subject: "[repo] Pull Request #342: Fix auth middleware",
    snippet: "User dependabot opened a pull request in your-org/backend-api...",
    date: "2026-03-10",
    body: "dependabot opened a pull request in your-org/backend-api\n\n#342 Fix auth middleware - update session handling\n\nThis PR updates the authentication middleware to fix a session expiration bug that was causing intermittent 401 errors for long-lived connections.\n\nFiles changed: 3\nAdditions: 47\nDeletions: 12",
  },
  {
    id: "email_004",
    from: "lisa.park@design.co",
    subject: "Updated Mockups Ready",
    snippet: "Hey! The updated mockups for the dashboard redesign are ready for review in Figma...",
    date: "2026-03-10",
    body: "Hey!\n\nThe updated mockups for the dashboard redesign are ready for review in Figma. I've incorporated all the feedback from last week's design review:\n\n- Simplified the navigation sidebar\n- Added the new analytics widgets\n- Updated the color scheme to match the brand guidelines\n\nLet me know what you think!\n\nLisa",
  },
  {
    id: "email_005",
    from: "no-reply@airline.com",
    subject: "Your Flight Confirmation - NYC to SFO",
    snippet: "Your booking is confirmed. Flight AA2847 departing March 20 at 8:15 AM...",
    date: "2026-03-09",
    body: "Booking Confirmation\n\nFlight: AA2847\nRoute: New York (JFK) to San Francisco (SFO)\nDate: March 20, 2026\nDeparture: 8:15 AM EST\nArrival: 11:45 AM PST\nSeat: 14A (Window)\nConfirmation Code: XKRT72\n\nPlease arrive at the airport at least 2 hours before departure.",
  },
];

let draftCounter = 1;

// ============================================================================
// TOOL DEFINITIONS + HANDLERS
// ============================================================================

export const tools: Tool[] = [
  {
    definition: {
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
    handler: (args) => {
      const limit = (args.limit as number) || 5;
      const emails = MOCK_EMAILS.slice(0, limit).map(({ id, from, subject, snippet, date }) => ({
        id,
        from,
        subject,
        snippet,
        date,
      }));
      return JSON.stringify({ emails, total: MOCK_EMAILS.length });
    },
  },

  {
    definition: {
      type: "function",
      name: "read_email",
      description: "Read the full content of a specific email by its ID.",
      parameters: {
        type: "object",
        properties: {
          email_id: {
            type: "string",
            description: "The ID of the email to read (e.g. email_001).",
          },
        },
        required: ["email_id"],
      },
    },
    handler: (args) => {
      const email = MOCK_EMAILS.find((e) => e.id === args.email_id);
      if (!email) {
        return JSON.stringify({ error: `Email with ID '${args.email_id}' not found.` });
      }
      return JSON.stringify(email);
    },
  },

  {
    definition: {
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
    handler: (args) => {
      const draftId = `draft_${String(draftCounter++).padStart(3, "0")}`;
      return JSON.stringify({
        success: true,
        draft_id: draftId,
        message: `Draft created: "${args.subject}" to ${args.to}.`,
      });
    },
  },

  {
    definition: {
      type: "function",
      name: "delete_email",
      description: "Permanently delete an email by its ID.",
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
    handler: (args) => {
      return JSON.stringify({
        success: true,
        message: `Email '${args.email_id}' has been permanently deleted.`,
      });
    },
  },

  {
    definition: {
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
    handler: (args) => {
      return JSON.stringify({
        success: true,
        message: `Email '${args.email_id}' has been archived.`,
      });
    },
  },

  {
    definition: {
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
    handler: (args) => {
      if (args.draft_id) {
        return JSON.stringify({
          success: true,
          message: `Draft '${args.draft_id}' has been sent.`,
        });
      }
      return JSON.stringify({
        success: true,
        message: `Email sent to ${args.to}: "${args.subject}".`,
      });
    },
  },
];
