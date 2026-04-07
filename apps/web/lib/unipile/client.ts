/**
 * Thin server-side Unipile REST client for hosted auth and account management.
 *
 * Handles only auth link generation and account status lookups. All email
 * operations (list, read, send, etc.) go through packages/email.
 *
 * Responsibilities:
 * - Create hosted auth links for Gmail/Outlook connect or reconnect
 * - Fetch account metadata/status for connected Unipile mailboxes
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const UNIPILE_API_KEY = process.env.UNIPILE_API_KEY;
const UNIPILE_DSN = process.env.UNIPILE_DSN;

// ============================================================================
// TYPES
// ============================================================================

/**
 * Input for creating a Unipile hosted auth link.
 * @param type - The auth type ("create" for new connection, "reconnect" for existing)
 * @param provider - The email provider to connect
 * @param expiresOn - ISO 8601 expiration timestamp (must include .000Z milliseconds)
 * @param notifyUrl - URL Unipile will POST to on completion
 * @param name - HMAC-signed correlation token for callback verification
 * @param reconnectAccountId - Unipile account ID to reconnect (only for type "reconnect")
 */
export interface CreateHostedAuthLinkInput {
  type: "create" | "reconnect";
  provider: "GOOGLE" | "OUTLOOK";
  expiresOn: string;
  notifyUrl: string;
  name: string;
  successRedirectUrl: string;
  reconnectAccountId?: string;
}

/**
 * Response from Unipile's hosted auth link endpoint.
 * @param url - The hosted auth URL to redirect the user to
 */
export interface HostedAuthLink {
  url: string;
}

/**
 * Unipile account metadata returned by the accounts endpoint.
 * Matches the real Unipile API response shape.
 * @param id - Unipile account ID
 * @param name - The name field set during hosted auth (our HMAC token)
 * @param type - Account type (e.g. "GOOGLE_OAUTH", "OUTLOOK")
 * @param status - Derived status: "connected" | "reconnect_required" | "error"
 * @param email - The email address associated with this account
 * @param connectionParams - Raw connection params from Unipile
 * @param sources - Raw sources array from Unipile
 */
export interface UnipileAccount {
  id: string;
  name: string;
  type: string;
  status: string;
  email: string;
  connectionParams: {
    mail?: { id: string; username: string };
  } | null;
  sources: Array<{ id: string; status: string }>;
}

// ============================================================================
// MAIN ENTRYPOINTS
// ============================================================================

/**
 * Creates a Unipile hosted auth link for Gmail/Outlook connect or reconnect.
 * Uses "providers" (array) and "expiresOn" (camelCase with .000Z) per Unipile API.
 * @param input - The hosted auth link parameters
 * @returns The hosted auth link URL
 */
export async function createHostedAuthLink(
  input: CreateHostedAuthLinkInput
): Promise<HostedAuthLink> {
  assertEnvVars();

  const body: Record<string, unknown> = {
    type: input.type,
    providers: [input.provider],
    api_url: UNIPILE_DSN,
    expiresOn: input.expiresOn,
    notify_url: input.notifyUrl,
    success_redirect_url: input.successRedirectUrl,
    name: input.name,
  };

  if (input.type === "reconnect" && input.reconnectAccountId) {
    body.reconnect_account = input.reconnectAccountId;
  }

  console.log("[unipile/client] createHostedAuthLink request body:", JSON.stringify(body, null, 2));

  const response = await fetch(`${UNIPILE_DSN}/api/v1/hosted/accounts/link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": UNIPILE_API_KEY!,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Unipile createHostedAuthLink failed (${response.status}): ${text}`
    );
  }

  const data = await response.json();
  console.log("[unipile/client] createHostedAuthLink response:", JSON.stringify(data, null, 2));
  return { url: data.url };
}

/**
 * Fetches the latest account metadata/status for a connected Unipile mailbox.
 * Email is at connection_params.mail.id (fallback to name field).
 * Status is derived from the MAILS source in sources array.
 * @param accountId - The Unipile account ID
 * @returns The account metadata including email, status, and type
 */
export async function getAccount(accountId: string): Promise<UnipileAccount> {
  assertEnvVars();

  const response = await fetch(
    `${UNIPILE_DSN}/api/v1/accounts/${accountId}`,
    {
      method: "GET",
      headers: {
        "X-API-KEY": UNIPILE_API_KEY!,
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Unipile getAccount failed (${response.status}): ${text}`
    );
  }

  const data = await response.json();

  // Extract email from connection_params.mail.id, fallback to name field
  const email = data.connection_params?.mail?.id || data.name || "";

  // Derive status from the MAILS source entry
  const sources: Array<{ id: string; status: string }> = data.sources ?? [];
  const mailsSource = sources.find((s: { id: string }) => s.id.endsWith("_MAILS"));
  const rawStatus = mailsSource?.status ?? "UNKNOWN";
  const status = mapAccountStatus(rawStatus);

  return {
    id: data.id,
    name: data.name,
    type: data.type,
    status,
    email,
    connectionParams: data.connection_params ?? null,
    sources,
  };
}

/**
 * Deletes (unlinks) an account from Unipile. Does not affect the underlying
 * Gmail/Outlook account -- only removes it from Unipile's system.
 * @param accountId - The Unipile account ID to delete
 */
export async function deleteAccount(accountId: string): Promise<void> {
  assertEnvVars();

  const response = await fetch(
    `${UNIPILE_DSN}/api/v1/accounts/${accountId}`,
    {
      method: "DELETE",
      headers: {
        "X-API-KEY": UNIPILE_API_KEY!,
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Unipile deleteAccount failed (${response.status}): ${text}`
    );
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Asserts that required Unipile environment variables are set.
 * Fails fast if either UNIPILE_API_KEY or UNIPILE_DSN is missing.
 */
function assertEnvVars(): void {
  if (!UNIPILE_API_KEY) {
    throw new Error("UNIPILE_API_KEY environment variable is not set");
  }
  if (!UNIPILE_DSN) {
    throw new Error("UNIPILE_DSN environment variable is not set");
  }
}

/**
 * Maps a Unipile source status string to our application status.
 * @param rawStatus - Raw status from sources[].status (e.g. "OK", "RECONNECT")
 * @returns Normalized status string
 */
function mapAccountStatus(rawStatus: string): string {
  switch (rawStatus) {
    case "OK":
      return "connected";
    case "RECONNECT":
      return "reconnect_required";
    default:
      return "error";
  }
}
