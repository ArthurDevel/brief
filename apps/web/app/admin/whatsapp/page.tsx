/**
 * Admin page for reviewing stored WhatsApp conversations.
 *
 * Responsibilities:
 * - Verify the current session belongs to an admin user
 * - List WhatsApp-linked users that can be selected in the admin UI
 * - Render the stored whatsapp_messages thread for the selected user
 */

import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isAdminUserId } from "@/lib/admin";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/client";

// ============================================================================
// TYPES
// ============================================================================

interface WhatsAppAdminPageProps {
  searchParams: Promise<{
    query?: string;
    userId?: string;
  }>;
}

interface UserSettingsRow {
  user_id: string | null;
  whatsapp_phone: string | null;
}

interface WhatsAppMessageRow {
  id: string;
  created_at: string;
  direction: "inbound" | "outbound";
  status: string;
  text: string;
}

interface WhatsAppAdminUserDto {
  userEmail: string;
  userId: string;
  whatsappPhone: string;
}

interface WhatsAppConversationMessageDto {
  createdAt: string;
  direction: "inbound" | "outbound";
  id: string;
  status: string;
  text: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_CONVERSATION_MESSAGES = 200;

const MESSAGE_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  year: "numeric",
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Redirects away from the admin area when the current user is not an admin.
 * @returns Promise that resolves when the current user is verified as an admin
 */
async function requireAdminUserId(): Promise<void> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isAdminUserId(user.id)) {
    redirect("/dashboard");
  }
}

/**
 * Fetches all auth users and builds a userId -> email lookup map.
 * @returns Map keyed by auth user ID
 */
async function buildUserEmailMap(): Promise<Map<string, string>> {
  const supabase = createServiceRoleClient();
  const userEmailMap = new Map<string, string>();
  let page = 1;
  const perPage = 1000;

  while (true) {
    const {
      data: { users },
      error,
    } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    });

    if (error) {
      throw new Error(`Failed to load admin user list: ${error.message}`);
    }

    for (const user of users) {
      if (user.email) {
        userEmailMap.set(user.id, user.email);
      }
    }

    if (users.length < perPage) {
      break;
    }

    page += 1;
  }

  return userEmailMap;
}

/**
 * Loads the WhatsApp-linked users shown in the admin selector.
 * @param query - Optional email, phone, or user ID search query
 * @returns User list sorted by email and phone
 */
async function listWhatsAppUsers(query: string): Promise<WhatsAppAdminUserDto[]> {
  const supabase = createServiceRoleClient();
  const userEmailMap = await buildUserEmailMap();
  const { data, error } = await supabase
    .from("user_settings")
    .select("user_id, whatsapp_phone")
    .not("whatsapp_phone", "is", null);

  if (error) {
    throw new Error(`Failed to load WhatsApp users: ${error.message}`);
  }

  const normalizedQuery = query.trim().toLowerCase();
  const rows = (data as UserSettingsRow[] | null) ?? [];
  const users = rows
    .filter((row) => Boolean(row.user_id) && Boolean(row.whatsapp_phone))
    .map((row) => ({
      userEmail: userEmailMap.get(row.user_id as string) ?? "unknown",
      userId: row.user_id as string,
      whatsappPhone: row.whatsapp_phone as string,
    }))
    .filter((user) => {
      if (!normalizedQuery) {
        return true;
      }

      return (
        user.userEmail.toLowerCase().includes(normalizedQuery) ||
        user.whatsappPhone.toLowerCase().includes(normalizedQuery) ||
        user.userId.toLowerCase().includes(normalizedQuery)
      );
    })
    .sort((left, right) => {
      const emailComparison = left.userEmail.localeCompare(right.userEmail);
      if (emailComparison !== 0) {
        return emailComparison;
      }

      return left.whatsappPhone.localeCompare(right.whatsappPhone);
    });

  return users;
}

/**
 * Loads stored WhatsApp messages for one user.
 * @param userId - Auth user ID
 * @returns Conversation messages ordered oldest first
 */
async function listConversationMessages(
  userId: string
): Promise<WhatsAppConversationMessageDto[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("whatsapp_messages")
    .select("id, created_at, direction, status, text")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(MAX_CONVERSATION_MESSAGES);

  if (error) {
    throw new Error(`Failed to load WhatsApp conversation: ${error.message}`);
  }

  return ((data as WhatsAppMessageRow[] | null) ?? []).map((row) => ({
    createdAt: row.created_at,
    direction: row.direction,
    id: row.id,
    status: row.status,
    text: row.text,
  }));
}

/**
 * Builds the query string for one admin page link.
 * @param userId - Optional selected user ID
 * @param query - Current search query
 * @returns Link href for the current page state
 */
function buildAdminHref(userId: string | null, query: string): string {
  const params = new URLSearchParams();

  if (query.trim()) {
    params.set("query", query.trim());
  }

  if (userId) {
    params.set("userId", userId);
  }

  const queryString = params.toString();
  if (!queryString) {
    return "/admin/whatsapp";
  }

  return `/admin/whatsapp?${queryString}`;
}

/**
 * Formats one stored message timestamp for the admin UI.
 * @param value - ISO timestamp from Supabase
 * @returns Localized timestamp string
 */
function formatMessageTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", MESSAGE_DATE_FORMAT).format(new Date(value));
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Renders the WhatsApp conversation admin page.
 * @param props - Selected user and optional search query
 * @returns Admin WhatsApp page
 */
export default async function WhatsAppAdminPage(
  props: WhatsAppAdminPageProps
) {
  await requireAdminUserId();

  const searchParams = await props.searchParams;
  const query = typeof searchParams.query === "string" ? searchParams.query : "";
  const requestedUserId =
    typeof searchParams.userId === "string" ? searchParams.userId : "";
  const users = await listWhatsAppUsers(query);
  const selectedUser =
    users.find((user) => user.userId === requestedUserId) ?? users[0] ?? null;
  const messages = selectedUser
    ? await listConversationMessages(selectedUser.userId)
    : [];

  return (
    <>
      <div className="page-header">
        <h1>WhatsApp Conversations</h1>
        <p>Admin-only view of stored WhatsApp message history</p>
      </div>

      <div className="page-content">
        <div className="grid gap-6 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
          <section
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border-color)",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <div style={{ borderBottom: "1px solid var(--border-color)", padding: 16 }}>
              <form action="/admin/whatsapp" method="get">
                <label
                  htmlFor="whatsapp-user-query"
                  style={{
                    color: "var(--text-secondary)",
                    display: "block",
                    fontSize: 12,
                    fontWeight: 600,
                    marginBottom: 8,
                    textTransform: "uppercase",
                  }}
                >
                  Select User
                </label>
                <input
                  defaultValue={query}
                  id="whatsapp-user-query"
                  name="query"
                  placeholder="Search email, phone, or user ID"
                  style={{
                    background: "var(--bg-main)",
                    border: "1px solid var(--border-color)",
                    color: "var(--text-primary)",
                    fontSize: 13,
                    outline: "none",
                    padding: "10px 12px",
                    width: "100%",
                  }}
                  type="text"
                />
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button
                    style={{
                      background: "var(--btn-primary-bg)",
                      border: "none",
                      color: "var(--btn-primary-text)",
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "8px 10px",
                    }}
                    type="submit"
                  >
                    Search
                  </button>
                  {query ? (
                    <Link
                      href="/admin/whatsapp"
                      style={{
                        alignItems: "center",
                        border: "1px solid var(--border-color)",
                        color: "var(--text-secondary)",
                        display: "inline-flex",
                        fontSize: 12,
                        fontWeight: 600,
                        padding: "8px 10px",
                        textDecoration: "none",
                      }}
                    >
                      Clear
                    </Link>
                  ) : null}
                </div>
              </form>
              <p style={{ color: "var(--text-secondary)", fontSize: 12, marginTop: 10 }}>
                {users.length} WhatsApp-linked user{users.length === 1 ? "" : "s"}
              </p>
            </div>

            <div style={{ maxHeight: "70vh", overflowY: "auto" }}>
              {users.length === 0 ? (
                <div style={{ color: "var(--text-secondary)", fontSize: 13, padding: 16 }}>
                  No WhatsApp-linked users matched this search.
                </div>
              ) : (
                users.map((user) => {
                  const isSelected = selectedUser?.userId === user.userId;

                  return (
                    <Link
                      href={buildAdminHref(user.userId, query)}
                      key={user.userId}
                      style={{
                        background: isSelected ? "var(--bg-hover)" : "transparent",
                        borderBottom: "1px solid var(--border-color)",
                        color: "inherit",
                        display: "block",
                        padding: 16,
                        textDecoration: "none",
                      }}
                    >
                      <div
                        style={{
                          color: "var(--text-primary)",
                          fontSize: 13,
                          fontWeight: 600,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {user.userEmail}
                      </div>
                      <div style={{ color: "var(--text-secondary)", fontSize: 12, marginTop: 4 }}>
                        {user.whatsappPhone}
                      </div>
                    </Link>
                  );
                })
              )}
            </div>
          </section>

          <section
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border-color)",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            {!selectedUser ? (
              <div style={{ color: "var(--text-secondary)", fontSize: 14, padding: 24 }}>
                Select a user to read the stored conversation.
              </div>
            ) : (
              <>
                <div style={{ borderBottom: "1px solid var(--border-color)", padding: 20 }}>
                  <div style={{ color: "var(--text-primary)", fontSize: 18, fontWeight: 600 }}>
                    {selectedUser.userEmail}
                  </div>
                  <div style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: 6 }}>
                    {selectedUser.whatsappPhone}
                  </div>
                  <div style={{ color: "var(--text-secondary)", fontSize: 12, marginTop: 8 }}>
                    User ID: {selectedUser.userId}
                  </div>
                  <div style={{ color: "var(--text-secondary)", fontSize: 12, marginTop: 8 }}>
                    Showing up to the last {MAX_CONVERSATION_MESSAGES} stored messages
                  </div>
                </div>

                <div style={{ display: "flex", flex: 1, flexDirection: "column", gap: 12, padding: 20 }}>
                  {messages.length === 0 ? (
                    <div style={{ color: "var(--text-secondary)", fontSize: 14 }}>
                      No WhatsApp messages have been stored for this user yet.
                    </div>
                  ) : (
                    messages.map((message) => {
                      const isInbound = message.direction === "inbound";

                      return (
                        <article
                          key={message.id}
                          style={{
                            alignSelf: isInbound ? "flex-start" : "flex-end",
                            background: isInbound ? "var(--bg-main)" : "var(--bg-hover)",
                            border: "1px solid var(--border-color)",
                            maxWidth: "80%",
                            padding: 14,
                            width: "fit-content",
                          }}
                        >
                          <div
                            style={{
                              color: "var(--text-secondary)",
                              fontSize: 11,
                              fontWeight: 600,
                              letterSpacing: "0.04em",
                              textTransform: "uppercase",
                            }}
                          >
                            {isInbound ? "Inbound" : "Outbound"} · {message.status}
                          </div>
                          <div
                            style={{
                              color: "var(--text-primary)",
                              fontSize: 14,
                              lineHeight: 1.5,
                              marginTop: 8,
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                            }}
                          >
                            {message.text}
                          </div>
                          <div style={{ color: "var(--text-secondary)", fontSize: 11, marginTop: 10 }}>
                            {formatMessageTimestamp(message.createdAt)}
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
