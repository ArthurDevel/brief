/**
 * Server actions for the transactional email admin dashboard.
 *
 * Fetches email_events from Supabase and resolves user emails
 * via the admin API. Includes an admin ID safety check so these
 * actions cannot be called outside of an admin context.
 *
 * Responsibilities:
 * - Fetch email events with optional filters (user email, email type)
 * - Resolve user IDs to email addresses via auth.admin.listUsers()
 * - Compute summary stats (total, today, per-type breakdown)
 */

"use server";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createServiceRoleClient } from "@/lib/supabase/client";
import { getCookieOptions } from "@/lib/supabase/client";
import { buildEngagementEmailHtml } from "@/lib/resend/client";
import type { EmailType, EngagementEmailContent } from "@/lib/engagement/types";

import { getContent as onboardingIncomplete1h } from "@/lib/resend/templates/onboarding-incomplete-1h";
import { getContent as onboardingIncomplete24h } from "@/lib/resend/templates/onboarding-incomplete-24h";
import { getContent as onboardingIncomplete72h } from "@/lib/resend/templates/onboarding-incomplete-72h";
import { getContent as welcome } from "@/lib/resend/templates/welcome";
import { getContent as noCallNudge24h } from "@/lib/resend/templates/no-call-nudge-24h";
import { getContent as noCallNudge72h } from "@/lib/resend/templates/no-call-nudge-72h";
import { getContent as firstCallFollowup } from "@/lib/resend/templates/first-call-followup";
import { getContent as scheduleNudge } from "@/lib/resend/templates/schedule-nudge";
import { getContent as reengagement3d } from "@/lib/resend/templates/reengagement-3d";
import { getContent as upgradeNudge } from "@/lib/resend/templates/upgrade-nudge";

// ============================================================================
// TYPES
// ============================================================================

export interface EmailEventItem {
  /** Primary key */
  id: string;
  /** The user's email address (resolved from auth.users) */
  userEmail: string;
  /** The user's auth ID */
  userId: string;
  /** Which engagement email was sent */
  emailType: string;
  /** Resend email ID (null if not recorded) */
  resendEmailId: string | null;
  /** When the email was sent */
  sentAt: string;
}

export interface EmailEventsResult {
  /** The email event rows */
  events: EmailEventItem[];
  /** Total count matching the filters (before pagination) */
  totalCount: number;
}

export interface EmailStats {
  /** Total emails ever sent */
  total: number;
  /** Emails sent in the last 24 hours */
  sentToday: number;
  /** Count per email type */
  byType: Record<string, number>;
}

interface FetchEmailEventsParams {
  /** Filter by user email (partial match) */
  searchEmail?: string;
  /** Filter by email type */
  emailType?: string;
  /** Pagination offset */
  offset?: number;
  /** Pagination limit */
  limit?: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "").split(",").filter(Boolean);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Verifies the current user is an admin. Throws if not.
 */
async function verifyAdmin(): Promise<void> {
  const cookieStore = await cookies();
  const cookieOptions = getCookieOptions();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      ...(cookieOptions ? { cookieOptions } : {}),
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Read-only in server actions
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !ADMIN_USER_IDS.includes(user.id)) {
    throw new Error("Unauthorized");
  }
}

/**
 * Fetches all auth users and builds a userId -> email lookup map.
 * Uses paginated admin API (max 1000 per page).
 * @param supabase - Service role Supabase client
 * @returns Map of userId to email address
 */
async function buildUserEmailMap(
  supabase: ReturnType<typeof createServiceRoleClient>
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let page = 1;
  const perPage = 1000;

  while (true) {
    const { data: { users }, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    });

    if (error) {
      throw new Error(`Failed to list users: ${error.message}`);
    }

    for (const user of users) {
      if (user.email) {
        map.set(user.id, user.email);
      }
    }

    if (users.length < perPage) break;
    page++;
  }

  return map;
}

// ============================================================================
// MAIN ACTIONS
// ============================================================================

/**
 * Fetches email events with optional filters and pagination.
 * @param params - Search email, email type filter, offset, limit
 * @returns The matching events and total count
 */
export async function fetchEmailEvents(
  params: FetchEmailEventsParams = {}
): Promise<EmailEventsResult> {
  await verifyAdmin();

  const { searchEmail, emailType, offset = 0, limit = 50 } = params;
  const supabase = createServiceRoleClient();

  // Build the user email map so we can filter by email and resolve IDs
  const userEmailMap = await buildUserEmailMap(supabase);

  // If searching by email, find matching user IDs first
  let filteredUserIds: string[] | null = null;
  if (searchEmail && searchEmail.trim()) {
    const search = searchEmail.trim().toLowerCase();
    filteredUserIds = [];
    for (const [userId, email] of userEmailMap) {
      if (email.toLowerCase().includes(search)) {
        filteredUserIds.push(userId);
      }
    }
  }

  // Query email_events
  let query = supabase
    .from("email_events")
    .select("*", { count: "exact" })
    .order("sent_at", { ascending: false });

  if (emailType) {
    query = query.eq("email_type", emailType);
  }

  if (filteredUserIds !== null) {
    if (filteredUserIds.length === 0) {
      // No matching users -- return empty
      return { events: [], totalCount: 0 };
    }
    query = query.in("user_id", filteredUserIds);
  }

  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) {
    throw new Error(`Failed to fetch email events: ${error.message}`);
  }

  const events: EmailEventItem[] = (data || []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    userEmail: userEmailMap.get(row.user_id as string) || "unknown",
    userId: row.user_id as string,
    emailType: row.email_type as string,
    resendEmailId: row.resend_email_id as string | null,
    sentAt: row.sent_at as string,
  }));

  return { events, totalCount: count || 0 };
}

/**
 * Fetches summary statistics for all email events.
 * @returns Total count, sent today count, and per-type breakdown
 */
export async function fetchEmailStats(): Promise<EmailStats> {
  await verifyAdmin();

  const supabase = createServiceRoleClient();

  // Fetch all events (only need email_type and sent_at for stats)
  const { data, error } = await supabase
    .from("email_events")
    .select("email_type, sent_at");

  if (error) {
    throw new Error(`Failed to fetch email stats: ${error.message}`);
  }

  const rows = data || [];
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const byType: Record<string, number> = {};
  let sentToday = 0;

  for (const row of rows) {
    // Per-type count
    const type = row.email_type as string;
    byType[type] = (byType[type] || 0) + 1;

    // Sent in last 24h
    if (new Date(row.sent_at as string) >= oneDayAgo) {
      sentToday++;
    }
  }

  return {
    total: rows.length,
    sentToday,
    byType,
  };
}

// ============================================================================
// PREVIEW
// ============================================================================

/** Maps each email type to its template getContent function. */
const TEMPLATE_MAP: Record<
  EmailType,
  (landerUrl: string, appUrl: string) => EngagementEmailContent
> = {
  onboarding_incomplete_1h: onboardingIncomplete1h,
  onboarding_incomplete_24h: onboardingIncomplete24h,
  onboarding_incomplete_72h: onboardingIncomplete72h,
  welcome: welcome,
  no_call_nudge_24h: noCallNudge24h,
  no_call_nudge_72h: noCallNudge72h,
  first_call_followup: firstCallFollowup,
  schedule_nudge: scheduleNudge,
  reengagement_3d: reengagement3d,
  upgrade_nudge: upgradeNudge,
};

/**
 * Returns the rendered HTML for a given email type, for preview purposes.
 * @param emailType - Which engagement email to preview
 * @returns The full HTML string
 */
export async function previewEmailHtml(emailType: EmailType): Promise<string> {
  await verifyAdmin();

  const landerUrl = process.env.LANDER_URL;
  if (!landerUrl) throw new Error("LANDER_URL is not set");

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) throw new Error("NEXT_PUBLIC_APP_URL is not set");

  const getContent = TEMPLATE_MAP[emailType];
  if (!getContent) {
    throw new Error(`Unknown email type: ${emailType}`);
  }

  const content = getContent(landerUrl, appUrl);
  return buildEngagementEmailHtml(content);
}
