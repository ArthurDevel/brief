/**
 * Orchestrator that fetches user data from Supabase and delegates
 * to pure filter functions to find engagement email candidates.
 *
 * Responsibilities:
 * - Fetch confirmed users via supabase.auth.admin.listUsers() (paginated)
 * - Fetch user_settings, sessions, subscriptions, email_events via .from()
 * - Map database snake_case rows to camelCase DTOs
 * - Call all four filter functions and return combined candidates
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  EmailAccountData,
  EmailCandidate,
  UserData,
  UserSettingsData,
  SessionData,
  SubscriptionData,
  SentEmailData,
} from "./types";
import {
  filterIncompleteOnboarding,
  filterGetStarted,
  filterReactivation,
  filterUpgrade,
  prioritizeCandidates,
  applyCooldown,
} from "./filters";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Fetches all confirmed users from the auth admin API, paginating
 * through results with perPage: 1000.
 * @param supabase - service role Supabase client
 * @returns array of UserData for confirmed users
 */
async function fetchConfirmedUsers(
  supabase: SupabaseClient
): Promise<UserData[]> {
  const users: UserData[] = [];
  let page = 1;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 1000,
    });

    if (error) {
      throw new Error(`Failed to list users (page ${page}): ${error.message}`);
    }

    for (const user of data.users) {
      // Only include users with confirmed emails
      if (user.email_confirmed_at && user.email) {
        users.push({
          userId: user.id,
          email: user.email,
          createdAt: user.created_at,
          emailConfirmedAt: user.email_confirmed_at,
        });
      }
    }

    // Stop if we got fewer than a full page
    if (data.users.length < 1000) break;
    page++;
  }

  return users;
}

/**
 * Fetches all rows from user_settings and maps to UserSettingsData.
 * @param supabase - service role Supabase client
 * @returns array of UserSettingsData
 */
async function fetchUserSettings(
  supabase: SupabaseClient
): Promise<UserSettingsData[]> {
  const { data, error } = await supabase
    .from("user_settings")
    .select("user_id, phone, pin_hash, call_schedule, updated_at");

  if (error) {
    throw new Error(`Failed to fetch user_settings: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    userId: row.user_id,
    phone: row.phone,
    pinHash: row.pin_hash,
    callSchedule: row.call_schedule,
    updatedAt: row.updated_at,
  }));
}

/**
 * Fetches users who have an active, connected email account.
 * @param supabase - service role Supabase client
 * @returns array of EmailAccountData (one per user with an active connected account)
 */
async function fetchEmailAccounts(
  supabase: SupabaseClient
): Promise<EmailAccountData[]> {
  const { data, error } = await supabase
    .from("user_email_accounts")
    .select("user_id")
    .eq("is_active", true)
    .eq("status", "connected");

  if (error) {
    throw new Error(`Failed to fetch user_email_accounts: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    userId: row.user_id,
  }));
}

/**
 * Fetches all rows from sessions and maps to SessionData.
 * @param supabase - service role Supabase client
 * @returns array of SessionData
 */
async function fetchSessions(
  supabase: SupabaseClient
): Promise<SessionData[]> {
  const { data, error } = await supabase
    .from("sessions")
    .select("user_id, started_at");

  if (error) {
    throw new Error(`Failed to fetch sessions: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    userId: row.user_id,
    startedAt: row.started_at,
  }));
}

/**
 * Fetches all rows from subscriptions and maps to SubscriptionData.
 * @param supabase - service role Supabase client
 * @returns array of SubscriptionData
 */
async function fetchSubscriptions(
  supabase: SupabaseClient
): Promise<SubscriptionData[]> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("user_id, plan");

  if (error) {
    throw new Error(`Failed to fetch subscriptions: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    userId: row.user_id,
    plan: row.plan,
  }));
}

/**
 * Fetches all rows from email_events and maps to SentEmailData.
 * @param supabase - service role Supabase client
 * @returns array of SentEmailData
 */
async function fetchSentEmails(
  supabase: SupabaseClient
): Promise<SentEmailData[]> {
  const { data, error } = await supabase
    .from("email_events")
    .select("user_id, email_type, sent_at");

  if (error) {
    throw new Error(`Failed to fetch email_events: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    userId: row.user_id,
    emailType: row.email_type,
    sentAt: row.sent_at,
  }));
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Fetches all relevant data from Supabase and runs all filter functions
 * to produce a deduplicated, cooldown-checked list of email candidates.
 *
 * Steps:
 * 1. Fetch confirmed users from auth admin API
 * 2. Fetch user_settings, sessions, subscriptions, email_events
 * 3. Run all four filter functions to get raw candidates
 * 4. Prioritize (one email per user) and apply 24h cooldown
 *
 * @param supabase - a Supabase client with service role permissions
 * @returns deduplicated and cooldown-filtered email candidates
 */
export async function findAllCandidates(
  supabase: SupabaseClient
): Promise<EmailCandidate[]> {
  // Step 1: Fetch all data in parallel
  const [users, settings, emailAccounts, sessions, subscriptions, sent] = await Promise.all([
    fetchConfirmedUsers(supabase),
    fetchUserSettings(supabase),
    fetchEmailAccounts(supabase),
    fetchSessions(supabase),
    fetchSubscriptions(supabase),
    fetchSentEmails(supabase),
  ]);

  // Step 2: Run all filter functions
  const incompleteCandidates = filterIncompleteOnboarding(
    users,
    settings,
    emailAccounts,
    sent
  );
  const getStartedCandidates = filterGetStarted(
    users,
    settings,
    emailAccounts,
    sessions,
    sent
  );
  const reactivationCandidates = filterReactivation(
    users,
    settings,
    emailAccounts,
    sessions,
    sent
  );
  const upgradeCandidates = filterUpgrade(
    users,
    settings,
    emailAccounts,
    sessions,
    subscriptions,
    sent
  );

  // Step 3: Combine all candidates
  const allCandidates = [
    ...incompleteCandidates,
    ...getStartedCandidates,
    ...reactivationCandidates,
    ...upgradeCandidates,
  ];

  // Step 4: Prioritize (one per user) and apply cooldown
  const prioritized = prioritizeCandidates(allCandidates);
  return applyCooldown(prioritized, sent);
}
