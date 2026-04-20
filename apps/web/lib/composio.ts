/**
 * Web-side Composio helpers for the WhatsApp connector flows.
 *
 * Responsibilities:
 * - Create the Composio SDK client for authenticated server routes
 * - Start a manual-auth flow for one supported toolkit
 * - Load live connector overview data directly from Composio
 * - Keep the external Composio user ID invariant in one place
 */

import { Composio } from "@composio/core";
import type {
  ComposioConnectionSummary,
  ComposioToolkitOverview,
} from "@/lib/types";

// ============================================================================
// CONSTANTS
// ============================================================================

const COMPOSIO_CONNECTED_ACCOUNTS_PAGE_LIMIT = 100;
const COMPOSIO_TOOLS_PAGE_LIMIT = 50;

export interface ComposioConnectionRequest {
  redirectUrl: string;
}

interface ComposioToolkitConnectionState {
  slug: string;
  connection?: {
    isActive: boolean;
    connectedAccount?: {
      id: string;
      status: string;
    };
  };
}

interface ComposioToolkitConnectionResponse {
  items: ComposioToolkitConnectionState[];
}

interface ComposioConnectedAccountListItem {
  id: string;
  status: string;
  statusReason: string | null;
  toolkit: {
    slug: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface ComposioConnectedAccountListResponse {
  items: ComposioConnectedAccountListItem[];
}

interface ComposioConnectedAccountDetail {
  id: string;
  status: string;
  statusReason: string | null;
  toolkit: {
    slug: string;
  };
  state?: {
    val?: Record<string, unknown>;
  };
  createdAt: string;
  updatedAt: string;
}

interface ComposioRawToolDefinition {
  slug?: string;
}

interface ComposioRawToolListResponse {
  items?: unknown[];
}

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Returns the external Composio user ID for a Supabase user.
 * @param userId - The Supabase auth user ID
 * @returns The external Composio user ID
 */
export function getComposioExternalUserId(userId: string): string {
  return userId;
}

/**
 * Creates a session for reading the WhatsApp connector state from Composio.
 * @param userId - The Supabase auth user ID
 * @param toolkits - Expected toolkit slugs for the WhatsApp flow
 * @returns Composio session scoped to this user and toolkit set
 */
export async function createWhatsAppComposioSession(
  userId: string,
  toolkits: string[]
): Promise<Awaited<ReturnType<Composio["create"]>>> {
  const composio = createComposioClient();

  return composio.create(getComposioExternalUserId(userId), {
    toolkits,
    manageConnections: false,
  });
}

/**
 * Loads the live overview for each expected WhatsApp connector.
 * @param userId - The Supabase auth user ID
 * @param toolkits - Expected toolkit slugs for the WhatsApp flow
 * @returns Live Composio overview rows ordered by the provided toolkits
 */
export async function listWhatsAppConnectorOverviews(
  userId: string,
  toolkits: string[]
): Promise<ComposioToolkitOverview[]> {
  const session = await createWhatsAppComposioSession(userId, toolkits);
  const composio = createComposioClient();
  const externalUserId = getComposioExternalUserId(userId);

  const [toolkitStateResponse, latestAccountsByToolkit, toolListsByToolkit] = await Promise.all([
    session.toolkits({
      limit: toolkits.length,
    }) as Promise<ComposioToolkitConnectionResponse>,
    listLatestConnectedAccountsByToolkit(composio, externalUserId, toolkits),
    listToolkitTools(toolkits),
  ]);

  const toolkitStatesBySlug = new Map(
    toolkitStateResponse.items.map((item) => [item.slug.trim().toLowerCase(), item])
  );

  return Promise.all(
    toolkits.map(async (toolkit) => {
      const normalizedToolkit = toolkit.trim().toLowerCase();
      const toolkitState = toolkitStatesBySlug.get(normalizedToolkit);
      const activeConnectedAccountId = toolkitState?.connection?.connectedAccount?.id ?? null;
      const fallbackConnectedAccount = latestAccountsByToolkit.get(normalizedToolkit) ?? null;
      const connectedAccountId = activeConnectedAccountId ?? fallbackConnectedAccount?.id ?? null;

      if (!connectedAccountId) {
        return {
          toolkit: normalizedToolkit,
          connectedAccountId: null,
          status: "NOT_CONNECTED",
          statusReason: null,
          connectedAt: null,
          updatedAt: null,
          scopes: [],
          tools: toolListsByToolkit.get(normalizedToolkit) ?? [],
        };
      }

      const connectedAccount = (await composio.connectedAccounts.get(
        connectedAccountId
      )) as ComposioConnectedAccountDetail;

      return {
        toolkit: normalizedToolkit,
        connectedAccountId: connectedAccount.id,
        status: normalizeConnectedAccountStatus(connectedAccount.status),
        statusReason: connectedAccount.statusReason ?? null,
        connectedAt: connectedAccount.createdAt,
        updatedAt: connectedAccount.updatedAt,
        scopes: extractConnectedAccountScopes(connectedAccount),
        tools: toolListsByToolkit.get(normalizedToolkit) ?? [],
      };
    })
  );
}

/**
 * Loads one WhatsApp connector summary in the legacy card DTO shape.
 * @param userId - The Supabase auth user ID
 * @param toolkit - Toolkit slug, for example "gmail" or "notion"
 * @returns Current connector summary, or null when no account exists
 */
export async function getWhatsAppConnectorConnectionSummary(
  userId: string,
  toolkit: string
): Promise<ComposioConnectionSummary | null> {
  const [overview] = await listWhatsAppConnectorOverviews(userId, [toolkit]);
  if (!overview) {
    throw new Error(`Composio did not return an overview for toolkit ${toolkit}.`);
  }

  if (overview.status === "NOT_CONNECTED") {
    return null;
  }

  return mapToolkitOverviewToConnectionSummary(userId, overview);
}

/**
 * Starts a manual-auth flow for a signed-in user.
 * @param userId - The Supabase auth user ID
 * @param toolkit - Toolkit slug, for example "gmail" or "notion"
 * @param callbackUrl - The app callback URL Composio should redirect to
 * @returns The redirect URL the browser should open
 */
export async function createComposioConnectionRequest(
  userId: string,
  toolkit: string,
  callbackUrl: string
): Promise<ComposioConnectionRequest> {
  const composio = createComposioClient();
  const session = await composio.create(getComposioExternalUserId(userId), {
    toolkits: [toolkit],
    manageConnections: false,
  });
  const connectionRequest = await session.authorize(toolkit, {
    callbackUrl,
  });
  if (!connectionRequest.redirectUrl) {
    throw new Error("Composio did not return a redirect URL.");
  }

  return {
    redirectUrl: connectionRequest.redirectUrl,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates a Composio SDK client for server-side use.
 * @returns Configured Composio client
 */
function createComposioClient(): Composio {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("COMPOSIO_API_KEY is not set");
  }

  return new Composio({
    apiKey,
  });
}

/**
 * Loads the most recently updated connected account for each toolkit.
 * @param composio - Configured Composio SDK client
 * @param externalUserId - External Composio user ID
 * @param toolkits - Expected toolkit slugs
 * @returns Most recent connected account keyed by toolkit slug
 */
async function listLatestConnectedAccountsByToolkit(
  composio: Composio,
  externalUserId: string,
  toolkits: string[]
): Promise<Map<string, ComposioConnectedAccountListItem>> {
  const response = (await composio.connectedAccounts.list({
    userIds: [externalUserId],
    toolkitSlugs: toolkits,
    limit: COMPOSIO_CONNECTED_ACCOUNTS_PAGE_LIMIT,
  })) as ComposioConnectedAccountListResponse;

  const latestAccountsByToolkit = new Map<string, ComposioConnectedAccountListItem>();

  for (const account of response.items) {
    const toolkit = account.toolkit.slug.trim().toLowerCase();
    const existingAccount = latestAccountsByToolkit.get(toolkit);

    if (!existingAccount) {
      latestAccountsByToolkit.set(toolkit, account);
      continue;
    }

    const existingUpdatedAt = new Date(existingAccount.updatedAt).getTime();
    const candidateUpdatedAt = new Date(account.updatedAt).getTime();

    if (candidateUpdatedAt > existingUpdatedAt) {
      latestAccountsByToolkit.set(toolkit, account);
    }
  }

  return latestAccountsByToolkit;
}

/**
 * Loads all raw tool slugs for the provided toolkits.
 * @param toolkits - Expected toolkit slugs
 * @returns Tool slugs keyed by toolkit slug
 */
async function listToolkitTools(
  toolkits: string[]
): Promise<Map<string, string[]>> {
  const composio = createComposioClient();
  const toolkitToolMap = new Map<string, string[]>();

  await Promise.all(
    toolkits.map(async (toolkit) => {
      toolkitToolMap.set(
        toolkit,
        await listRawToolSlugsForToolkit(composio, toolkit)
      );
    })
  );

  return toolkitToolMap;
}

/**
 * Loads all raw tool slugs for one toolkit.
 * @param composio - Configured Composio SDK client
 * @param toolkit - Toolkit slug
 * @returns Sorted tool slugs for the toolkit
 */
async function listRawToolSlugsForToolkit(
  composio: Composio,
  toolkit: string
): Promise<string[]> {
  const toolSlugs = new Set<string>();
  const response = (await composio.tools.getRawComposioTools({
    toolkits: [toolkit],
    limit: COMPOSIO_TOOLS_PAGE_LIMIT,
  })) as ComposioRawToolListResponse | ComposioRawToolDefinition[];

  const pageItems = normalizeRawToolList(response);
  for (const tool of pageItems) {
    const slug = tool.slug?.trim();
    if (!slug) {
      continue;
    }

    toolSlugs.add(slug);
  }

  return Array.from(toolSlugs).sort((left, right) => left.localeCompare(right));
}

/**
 * Normalizes raw tool list responses across Composio SDK response shapes.
 * @param response - Raw response from getRawComposioTools
 * @returns Raw tool items
 */
function normalizeRawToolList(
  response: ComposioRawToolListResponse | ComposioRawToolDefinition[]
): ComposioRawToolDefinition[] {
  if (Array.isArray(response)) {
    return response;
  }

  if (Array.isArray(response.items)) {
    return response.items as ComposioRawToolDefinition[];
  }

  return [];
}

/**
 * Normalizes connected-account status values to the supported UI union.
 * @param status - Raw status returned by Composio
 * @returns Normalized status used by the web app
 */
function normalizeConnectedAccountStatus(
  status: string
): ComposioToolkitOverview["status"] {
  switch (status) {
    case "ACTIVE":
    case "INITIATED":
    case "EXPIRED":
    case "FAILED":
    case "INACTIVE":
      return status;
    default:
      throw new Error(`Unsupported Composio connected account status: ${status}`);
  }
}

/**
 * Extracts OAuth scopes from a connected-account state when Composio exposes them.
 * @param connectedAccount - Connected-account detail returned by Composio
 * @returns Unique granted scopes in display order
 */
function extractConnectedAccountScopes(
  connectedAccount: ComposioConnectedAccountDetail
): string[] {
  const stateValues = connectedAccount.state?.val;
  if (!stateValues || typeof stateValues !== "object") {
    return [];
  }

  const directScopes = normalizeScopeValue(stateValues.scope);
  const authedUserScopes = extractAuthedUserScopes(stateValues.authed_user);

  return Array.from(new Set([...directScopes, ...authedUserScopes]));
}

/**
 * Normalizes a scope field that may be a string, array, or null.
 * @param value - Raw scope value from Composio
 * @returns Parsed scopes
 */
function normalizeScopeValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Extracts nested OAuth scopes from the auth provider's authed user payload.
 * @param authedUser - Raw authed_user object from Composio
 * @returns Parsed scopes
 */
function extractAuthedUserScopes(authedUser: unknown): string[] {
  if (!authedUser || typeof authedUser !== "object") {
    return [];
  }

  return normalizeScopeValue((authedUser as Record<string, unknown>).scope);
}

/**
 * Maps a live toolkit overview into the connector card DTO.
 * @param userId - The Supabase auth user ID
 * @param overview - Live Composio overview for one toolkit
 * @returns Connector summary used by the WhatsApp connector pages
 */
function mapToolkitOverviewToConnectionSummary(
  userId: string,
  overview: ComposioToolkitOverview
): ComposioConnectionSummary {
  return {
    toolkit: overview.toolkit,
    provider: "composio",
    connectedAccountId: overview.connectedAccountId,
    status: mapToolkitOverviewStatus(overview.status),
    externalUserId: getComposioExternalUserId(userId),
    connectedAt: overview.connectedAt,
    lastError: overview.statusReason,
  };
}

/**
 * Maps Composio connected-account status values to the connector-page status union.
 * @param status - Live Composio connected-account status
 * @returns Connector-page status
 */
function mapToolkitOverviewStatus(
  status: ComposioToolkitOverview["status"]
): ComposioConnectionSummary["status"] {
  switch (status) {
    case "ACTIVE":
      return "connected";
    case "INITIATED":
      return "pending";
    case "EXPIRED":
    case "INACTIVE":
      return "reconnect_required";
    case "FAILED":
      return "error";
    case "NOT_CONNECTED":
      return "not_connected";
  }
}
