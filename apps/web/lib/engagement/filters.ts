/**
 * Pure filter functions for the engagement email system.
 *
 * Takes pre-fetched arrays of users, settings, sessions, subscriptions, and
 * sent emails, then returns EmailCandidate[] for each engagement path.
 * No I/O -- all data is passed in, making these functions easy to unit test.
 *
 * Responsibilities:
 * - Filter users with incomplete onboarding into 1h/24h/72h email candidates
 * - Filter users with complete onboarding into get-started email candidates
 * - Filter inactive users into reactivation candidates
 * - Filter free-plan active users into upgrade candidates
 * - Deduplicate candidates by priority (one email per user per cron run)
 * - Apply 24h cooldown to prevent email flooding
 */

import type {
  EmailCandidate,
  EmailAccountData,
  EmailType,
  UserData,
  UserSettingsData,
  SessionData,
  SubscriptionData,
  SentEmailData,
} from "./types";

// ============================================================================
// CONSTANTS
// ============================================================================

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;
const SEVENTY_TWO_HOURS_MS = 72 * ONE_HOUR_MS;
const THREE_DAYS_MS = 3 * 24 * ONE_HOUR_MS;
const FOURTEEN_DAYS_MS = 14 * 24 * ONE_HOUR_MS;

/** Priority order: lower index = higher priority. */
const EMAIL_PRIORITY: EmailType[] = [
  "onboarding_incomplete_1h",
  "onboarding_incomplete_24h",
  "onboarding_incomplete_72h",
  "welcome",
  "no_call_nudge_24h",
  "no_call_nudge_72h",
  "first_call_followup",
  "schedule_nudge",
  "reengagement_3d",
  "upgrade_nudge",
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Checks whether a user has confirmed their email address.
 * @param user - the user data
 * @returns true if emailConfirmedAt is set
 */
function isEmailConfirmed(user: UserData): boolean {
  return user.emailConfirmedAt !== null;
}

/**
 * Checks whether a user has completed onboarding.
 * Requires phone and pinHash set in user_settings, plus an active
 * connected email account in user_email_accounts.
 * @param settings - the user's settings row
 * @param hasEmailAccount - whether the user has an active connected email account
 * @returns true if all onboarding steps are complete
 */
function isOnboardingComplete(
  settings: UserSettingsData,
  hasEmailAccount: boolean
): boolean {
  return (
    settings.phone !== null &&
    settings.pinHash !== null &&
    hasEmailAccount
  );
}

/**
 * Checks whether a specific emailType has already been sent to a user.
 * @param userId - the user ID
 * @param emailType - the email type to check
 * @param sent - array of previously sent emails
 * @returns true if already sent
 */
function alreadySent(
  userId: string,
  emailType: EmailType,
  sent: SentEmailData[]
): boolean {
  return sent.some((s) => s.userId === userId && s.emailType === emailType);
}

/**
 * Returns how many milliseconds have elapsed since the given ISO date string.
 * @param isoDate - an ISO 8601 date string
 * @returns milliseconds since that date
 */
function msSince(isoDate: string): number {
  return Date.now() - new Date(isoDate).getTime();
}

// ============================================================================
// FILTER FUNCTIONS
// ============================================================================

/**
 * Returns candidates for incomplete onboarding emails (1h, 24h, 72h).
 *
 * A user is "incomplete" if phone, imapHost, or pinHash is null in their
 * settings. Time since signup (createdAt) determines which emails they qualify
 * for. Uses wide windows: 72h+ qualifies for all three emails.
 *
 * @param users - all users from auth
 * @param settings - all user_settings rows
 * @param emailAccounts - users with active connected email accounts
 * @param sent - all previously sent email events
 * @returns candidates for incomplete onboarding emails
 */
export function filterIncompleteOnboarding(
  users: UserData[],
  settings: UserSettingsData[],
  emailAccounts: EmailAccountData[],
  sent: SentEmailData[]
): EmailCandidate[] {
  const settingsMap = new Map(settings.map((s) => [s.userId, s]));
  const emailAccountSet = new Set(emailAccounts.map((a) => a.userId));
  const candidates: EmailCandidate[] = [];

  for (const user of users) {
    const userSettings = settingsMap.get(user.userId);

    // If no settings row exists, user is incomplete (nothing set up yet)
    // If settings exist but onboarding is complete, skip
    if (userSettings && isOnboardingComplete(userSettings, emailAccountSet.has(user.userId))) continue;

    const timeSinceSignup = msSince(user.createdAt);

    // Wide windows: check from largest to smallest, add all that qualify
    const thresholds: Array<{ ms: number; emailType: EmailType }> = [
      { ms: SEVENTY_TWO_HOURS_MS, emailType: "onboarding_incomplete_72h" },
      { ms: TWENTY_FOUR_HOURS_MS, emailType: "onboarding_incomplete_24h" },
      { ms: ONE_HOUR_MS, emailType: "onboarding_incomplete_1h" },
    ];

    for (const { ms, emailType } of thresholds) {
      if (
        timeSinceSignup >= ms &&
        !alreadySent(user.userId, emailType, sent)
      ) {
        candidates.push({
          userId: user.userId,
          email: user.email,
          emailType,
        });
      }
    }
  }

  return candidates;
}

/**
 * Returns candidates for get-started emails (welcome, no_call_nudge_24h,
 * no_call_nudge_72h, first_call_followup, schedule_nudge).
 *
 * Only for users with complete onboarding. Time is measured from
 * settings.updatedAt (proxy for onboarding completion time).
 *
 * @param users - all users from auth
 * @param settings - all user_settings rows
 * @param emailAccounts - users with active connected email accounts
 * @param sessions - all session rows
 * @param sent - all previously sent email events
 * @returns candidates for get-started emails
 */
export function filterGetStarted(
  users: UserData[],
  settings: UserSettingsData[],
  emailAccounts: EmailAccountData[],
  sessions: SessionData[],
  sent: SentEmailData[]
): EmailCandidate[] {
  const settingsMap = new Map(settings.map((s) => [s.userId, s]));
  const emailAccountSet = new Set(emailAccounts.map((a) => a.userId));
  const candidates: EmailCandidate[] = [];

  // Group sessions by userId
  const sessionsMap = new Map<string, SessionData[]>();
  for (const session of sessions) {
    const existing = sessionsMap.get(session.userId) ?? [];
    existing.push(session);
    sessionsMap.set(session.userId, existing);
  }

  for (const user of users) {
    if (!isEmailConfirmed(user)) continue;

    const userSettings = settingsMap.get(user.userId);
    if (!userSettings || !isOnboardingComplete(userSettings, emailAccountSet.has(user.userId))) continue;

    const timeSinceOnboarding = msSince(userSettings.updatedAt);
    const userSessions = sessionsMap.get(user.userId) ?? [];
    const sessionCount = userSessions.length;

    // welcome: 1h+ after onboarding complete
    if (
      timeSinceOnboarding >= ONE_HOUR_MS &&
      !alreadySent(user.userId, "welcome", sent)
    ) {
      candidates.push({
        userId: user.userId,
        email: user.email,
        emailType: "welcome",
      });
    }

    // no_call_nudge_24h: 24h+ after onboarding, 0 sessions
    if (
      timeSinceOnboarding >= TWENTY_FOUR_HOURS_MS &&
      sessionCount === 0 &&
      !alreadySent(user.userId, "no_call_nudge_24h", sent)
    ) {
      candidates.push({
        userId: user.userId,
        email: user.email,
        emailType: "no_call_nudge_24h",
      });
    }

    // no_call_nudge_72h: 72h+ after onboarding, 0 sessions
    if (
      timeSinceOnboarding >= SEVENTY_TWO_HOURS_MS &&
      sessionCount === 0 &&
      !alreadySent(user.userId, "no_call_nudge_72h", sent)
    ) {
      candidates.push({
        userId: user.userId,
        email: user.email,
        emailType: "no_call_nudge_72h",
      });
    }

    // first_call_followup: 24h+ after first session, 1+ sessions
    if (sessionCount >= 1) {
      // Find earliest session
      const firstSession = userSessions.reduce((earliest, s) =>
        new Date(s.startedAt).getTime() < new Date(earliest.startedAt).getTime()
          ? s
          : earliest
      );
      const timeSinceFirstSession = msSince(firstSession.startedAt);

      if (
        timeSinceFirstSession >= TWENTY_FOUR_HOURS_MS &&
        !alreadySent(user.userId, "first_call_followup", sent)
      ) {
        candidates.push({
          userId: user.userId,
          email: user.email,
          emailType: "first_call_followup",
        });
      }
    }

    // schedule_nudge: 3d+ after onboarding, no callSchedule set
    if (
      timeSinceOnboarding >= THREE_DAYS_MS &&
      userSettings.callSchedule === null &&
      !alreadySent(user.userId, "schedule_nudge", sent)
    ) {
      candidates.push({
        userId: user.userId,
        email: user.email,
        emailType: "schedule_nudge",
      });
    }
  }

  return candidates;
}

/**
 * Returns candidates for the reactivation email (reengagement_3d).
 *
 * Users must have complete onboarding, 1+ sessions, and 3d+ since their
 * most recent session.
 *
 * @param users - all users from auth
 * @param settings - all user_settings rows
 * @param emailAccounts - users with active connected email accounts
 * @param sessions - all session rows
 * @param sent - all previously sent email events
 * @returns candidates for reactivation email
 */
export function filterReactivation(
  users: UserData[],
  settings: UserSettingsData[],
  emailAccounts: EmailAccountData[],
  sessions: SessionData[],
  sent: SentEmailData[]
): EmailCandidate[] {
  const settingsMap = new Map(settings.map((s) => [s.userId, s]));
  const emailAccountSet = new Set(emailAccounts.map((a) => a.userId));
  const candidates: EmailCandidate[] = [];

  // Group sessions by userId
  const sessionsMap = new Map<string, SessionData[]>();
  for (const session of sessions) {
    const existing = sessionsMap.get(session.userId) ?? [];
    existing.push(session);
    sessionsMap.set(session.userId, existing);
  }

  for (const user of users) {
    if (!isEmailConfirmed(user)) continue;

    const userSettings = settingsMap.get(user.userId);
    if (!userSettings || !isOnboardingComplete(userSettings, emailAccountSet.has(user.userId))) continue;

    const userSessions = sessionsMap.get(user.userId) ?? [];
    if (userSessions.length === 0) continue;

    // Find most recent session
    const lastSession = userSessions.reduce((latest, s) =>
      new Date(s.startedAt).getTime() > new Date(latest.startedAt).getTime()
        ? s
        : latest
    );

    const timeSinceLastSession = msSince(lastSession.startedAt);

    if (
      timeSinceLastSession >= THREE_DAYS_MS &&
      !alreadySent(user.userId, "reengagement_3d", sent)
    ) {
      candidates.push({
        userId: user.userId,
        email: user.email,
        emailType: "reengagement_3d",
      });
    }
  }

  return candidates;
}

/**
 * Returns candidates for the upgrade nudge email.
 *
 * Users must have complete onboarding, free plan, 3+ sessions, and
 * 14d+ since signup.
 *
 * @param users - all users from auth
 * @param settings - all user_settings rows
 * @param emailAccounts - users with active connected email accounts
 * @param sessions - all session rows
 * @param subscriptions - all subscription rows
 * @param sent - all previously sent email events
 * @returns candidates for upgrade nudge email
 */
export function filterUpgrade(
  users: UserData[],
  settings: UserSettingsData[],
  emailAccounts: EmailAccountData[],
  sessions: SessionData[],
  subscriptions: SubscriptionData[],
  sent: SentEmailData[]
): EmailCandidate[] {
  const settingsMap = new Map(settings.map((s) => [s.userId, s]));
  const emailAccountSet = new Set(emailAccounts.map((a) => a.userId));
  const subscriptionMap = new Map(subscriptions.map((s) => [s.userId, s]));
  const candidates: EmailCandidate[] = [];

  // Count sessions per user
  const sessionCountMap = new Map<string, number>();
  for (const session of sessions) {
    sessionCountMap.set(
      session.userId,
      (sessionCountMap.get(session.userId) ?? 0) + 1
    );
  }

  for (const user of users) {
    if (!isEmailConfirmed(user)) continue;

    const userSettings = settingsMap.get(user.userId);
    if (!userSettings || !isOnboardingComplete(userSettings, emailAccountSet.has(user.userId))) continue;

    const subscription = subscriptionMap.get(user.userId);
    if (!subscription || subscription.plan !== "free") continue;

    const sessionCount = sessionCountMap.get(user.userId) ?? 0;
    if (sessionCount < 3) continue;

    const timeSinceSignup = msSince(user.createdAt);
    if (timeSinceSignup < FOURTEEN_DAYS_MS) continue;

    if (!alreadySent(user.userId, "upgrade_nudge", sent)) {
      candidates.push({
        userId: user.userId,
        email: user.email,
        emailType: "upgrade_nudge",
      });
    }
  }

  return candidates;
}

// ============================================================================
// PRIORITIZATION AND COOLDOWN
// ============================================================================

/**
 * Deduplicates candidates by userId, keeping only the highest-priority
 * email per user. Priority order matches EMAIL_PRIORITY constant
 * (lower index = higher priority).
 *
 * @param candidates - all candidates from all filter functions
 * @returns at most one candidate per user (the highest priority one)
 */
export function prioritizeCandidates(
  candidates: EmailCandidate[]
): EmailCandidate[] {
  const bestByUser = new Map<string, EmailCandidate>();

  for (const candidate of candidates) {
    const existing = bestByUser.get(candidate.userId);

    if (!existing) {
      bestByUser.set(candidate.userId, candidate);
      continue;
    }

    const existingPriority = EMAIL_PRIORITY.indexOf(existing.emailType);
    const candidatePriority = EMAIL_PRIORITY.indexOf(candidate.emailType);

    if (candidatePriority < existingPriority) {
      bestByUser.set(candidate.userId, candidate);
    }
  }

  return Array.from(bestByUser.values());
}

/**
 * Removes candidates whose userId has any sent email with sentAt within
 * the last 24 hours. Prevents multiple emails landing close together.
 *
 * @param candidates - prioritized candidates
 * @param sent - all previously sent email events
 * @returns candidates that pass the cooldown check
 */
export function applyCooldown(
  candidates: EmailCandidate[],
  sent: SentEmailData[]
): EmailCandidate[] {
  const now = Date.now();

  // Build set of userIds that have been emailed in the last 24h
  const recentlySentUserIds = new Set<string>();
  for (const s of sent) {
    if (now - new Date(s.sentAt).getTime() < TWENTY_FOUR_HOURS_MS) {
      recentlySentUserIds.add(s.userId);
    }
  }

  return candidates.filter((c) => !recentlySentUserIds.has(c.userId));
}
