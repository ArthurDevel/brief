/**
 * API route for current billing period usage information.
 *
 * Returns the user's plan, hours used, hours remaining, and billing
 * period dates. Usage is calculated from the sessions table.
 *
 * Responsibilities:
 * - Authenticate the request
 * - Look up the user's subscription/plan
 * - Sum session durations for the current billing period
 * - Return UsageInfo DTO
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import type { UsageInfo } from "@/lib/types";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Hours limit per plan. */
const PLAN_HOURS: Record<string, number> = {
  free: 1,
  pro: 5,
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Returns the start and end dates of the current billing period (calendar month).
 * @returns Object with periodStart and periodEnd as ISO date strings
 */
function getCurrentBillingPeriod(): { periodStart: string; periodEnd: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  return {
    periodStart: start.toISOString().split("T")[0],
    periodEnd: end.toISOString().split("T")[0],
  };
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Returns current billing period usage info.
 * @param _request - The incoming request (unused)
 * @returns JSON response with UsageInfo
 */
export async function GET(_request: NextRequest): Promise<NextResponse<UsageInfo | { error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" } as unknown as UsageInfo, { status: 401 });
  }

  // Get the user's plan from subscriptions table
  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("plan")
    .eq("user_id", user.id)
    .single();

  const plan = (subscription?.plan as "free" | "pro") ?? "free";
  const hoursLimit = PLAN_HOURS[plan] ?? 1;

  // Calculate usage for the current billing period
  const { periodStart, periodEnd } = getCurrentBillingPeriod();

  const { data: sessions } = await supabase
    .from("sessions")
    .select("duration_seconds")
    .eq("user_id", user.id)
    .gte("started_at", periodStart)
    .lte("started_at", `${periodEnd}T23:59:59`);

  const totalSeconds = (sessions ?? []).reduce(
    (sum, s) => sum + ((s.duration_seconds as number) ?? 0),
    0
  );
  const hoursUsed = totalSeconds / 3600;
  const hoursRemaining = Math.max(0, hoursLimit - hoursUsed);

  const usage: UsageInfo = {
    plan,
    hoursUsed,
    hoursLimit,
    hoursRemaining,
    periodStart,
    periodEnd,
  };

  return NextResponse.json(usage);
}
