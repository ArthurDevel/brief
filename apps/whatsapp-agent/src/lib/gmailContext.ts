/**
 * Builds the "emails since last call" greeting line for the system prompt.
 *
 * Responsibilities:
 * - Call GMAIL_FETCH_EMAILS via the caller's Composio session
 * - Mirror voice-pipeline behavior: unread count on first call, since-count after
 * - Return one short string suitable for inclusion in the system prompt
 */

import type { ComposioUserSession } from "./composio.js";

// ============================================================================
// TYPES
// ============================================================================

interface GmailFetchData {
  resultSizeEstimate?: number;
  messages?: unknown[];
}

interface GmailFetchResult {
  data?: GmailFetchData;
  error?: unknown;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Builds the greeting line about unread or new-since-last-call emails.
 * Mirrors the phrasing used by the voice pipeline.
 * @param session - Active Composio user session for the caller
 * @param lastCallEndedAt - End time of the last completed call, or null on first call
 * @returns One-line greeting string the LLM should mention to the user
 */
export async function buildGmailContextLine(
  session: ComposioUserSession,
  lastCallEndedAt: Date | null
): Promise<string> {
  const isFirstCall = lastCallEndedAt === null;

  // Gmail's `after:` operator accepts a unix timestamp in seconds.
  const query = isFirstCall
    ? "is:unread"
    : `after:${Math.floor(lastCallEndedAt.getTime() / 1000)}`;

  const count = await fetchGmailCount(session, query);

  if (isFirstCall) {
    if (count > 0) {
      return `This is the user's first call. They have ${count} unread emails in their inbox.`;
    }
    return "This is the user's first call. They have no unread emails.";
  }

  if (count > 0) {
    return `You have ${count} new emails since the last call.`;
  }
  return "No new emails since the last call.";
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Executes GMAIL_FETCH_EMAILS and returns the estimated total match count.
 * Uses ids_only and maxResults=1 because only the count is needed.
 * @param session - Active Composio user session for the caller
 * @param query - Gmail search query string
 * @returns Estimated number of matching messages
 */
async function fetchGmailCount(
  session: ComposioUserSession,
  query: string
): Promise<number> {
  const result = (await session.execute("GMAIL_FETCH_EMAILS", {
    user_id: "me",
    q: query,
    maxResults: 1,
    ids_only: true,
  })) as GmailFetchResult;

  if (result.error) {
    throw new Error(
      `GMAIL_FETCH_EMAILS failed: ${JSON.stringify(result.error)}`
    );
  }

  const estimate = result.data?.resultSizeEstimate;
  if (typeof estimate === "number" && Number.isFinite(estimate)) {
    return estimate;
  }

  // Fallback: when Gmail does not return resultSizeEstimate, count what was returned.
  if (Array.isArray(result.data?.messages)) {
    return result.data.messages.length;
  }

  return 0;
}
