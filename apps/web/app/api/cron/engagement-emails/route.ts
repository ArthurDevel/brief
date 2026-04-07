/**
 * Cron endpoint for sending engagement emails.
 *
 * Called every 15 minutes by Vercel Cron. Finds users eligible for
 * engagement emails, resolves their template content, sends via Resend,
 * and records each send in the email_events table.
 *
 * Responsibilities:
 * - Verify CRON_SECRET auth header
 * - Find all eligible email candidates via findAllCandidates()
 * - Limit to 50 candidates per run (oldest signup first)
 * - Resolve template content per email type
 * - Send emails via sendEngagementEmail()
 * - Record sent emails in email_events (upsert with ignoreDuplicates)
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/client";
import { findAllCandidates } from "@/lib/engagement/checks";
import { sendEngagementEmail } from "@/lib/resend/client";
import type {
  EmailType,
  EmailCandidate,
  EngagementEmailContent,
} from "@/lib/engagement/types";

// Template getContent imports
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
// CONSTANTS
// ============================================================================

const MAX_EMAILS_PER_RUN = 50;

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

// ============================================================================
// TYPES
// ============================================================================

interface CronResult {
  sent: number;
  errors: number;
}

// ============================================================================
// ENDPOINT
// ============================================================================

/**
 * Cron handler that finds eligible users and sends engagement emails.
 * Verifies CRON_SECRET, fetches candidates, sends up to 50 emails,
 * and records each successful send in email_events.
 *
 * @param request - The incoming cron request with authorization header
 * @returns JSON with sent and error counts
 */
export async function GET(
  request: NextRequest
): Promise<NextResponse<CronResult | { error: string }>> {
  // Step 1: Verify cron auth
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    throw new Error("CRON_SECRET is not set");
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const landerUrl = process.env.LANDER_URL;
  if (!landerUrl) {
    throw new Error("LANDER_URL is not set");
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    throw new Error("NEXT_PUBLIC_APP_URL is not set");
  }

  console.log("[engagement-cron] Starting engagement email run");

  // Step 2: Create service role client and find candidates
  const supabase = createServiceRoleClient();
  const allCandidates = await findAllCandidates(supabase);

  // Step 3: Limit to MAX_EMAILS_PER_RUN (candidates are already in signup order)
  const candidates = allCandidates.slice(0, MAX_EMAILS_PER_RUN);

  console.log(
    `[engagement-cron] ${allCandidates.length} total candidates, processing ${candidates.length}`
  );

  // Step 4: Send emails and record results
  let sent = 0;
  let errors = 0;

  for (const candidate of candidates) {
    try {
      const resendId = await sendOneEmail(candidate, landerUrl, appUrl);

      if (resendId) {
        await recordEmailEvent(supabase, candidate, resendId);
        sent++;
      } else {
        errors++;
      }
    } catch (error) {
      console.error(
        `[engagement-cron] Error processing ${candidate.emailType} for ${candidate.email}:`,
        error
      );
      errors++;
    }
  }

  console.log(`[engagement-cron] Done: ${sent} sent, ${errors} errors`);
  return NextResponse.json({ sent, errors });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Resolves the template for a candidate and sends the email via Resend.
 * @param candidate - The email candidate with userId, email, and emailType
 * @param landerUrl - The lander site base URL
 * @param appUrl - The app base URL
 * @returns The Resend email ID on success, or null on failure
 */
async function sendOneEmail(
  candidate: EmailCandidate,
  landerUrl: string,
  appUrl: string
): Promise<string | null> {
  const getContent = TEMPLATE_MAP[candidate.emailType];
  const content = getContent(landerUrl, appUrl);
  return sendEngagementEmail(candidate.email, content);
}

/**
 * Records a sent email in the email_events table.
 * Uses upsert with ignoreDuplicates to handle race conditions
 * (unique constraint on user_id + email_type).
 * @param supabase - Service role Supabase client
 * @param candidate - The email candidate that was sent
 * @param resendEmailId - The Resend email ID from the send response
 */
async function recordEmailEvent(
  supabase: ReturnType<typeof createServiceRoleClient>,
  candidate: EmailCandidate,
  resendEmailId: string
): Promise<void> {
  const { error } = await supabase.from("email_events").upsert(
    {
      user_id: candidate.userId,
      email_type: candidate.emailType,
      resend_email_id: resendEmailId,
    },
    {
      onConflict: "user_id,email_type",
      ignoreDuplicates: true,
    }
  );

  if (error) {
    console.error(
      `[engagement-cron] Failed to record email_event for ${candidate.email} (${candidate.emailType}):`,
      error.message
    );
  }
}
