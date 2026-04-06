/**
 * Tests for the engagement email filter pipeline.
 *
 * Tests focus on outcomes: given a realistic set of users in various states,
 * does the pipeline produce the right candidates?
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  filterIncompleteOnboarding,
  filterGetStarted,
  filterReactivation,
  filterUpgrade,
  prioritizeCandidates,
  applyCooldown,
} from "../filters";
import type {
  UserData,
  UserSettingsData,
  SessionData,
  SubscriptionData,
  SentEmailData,
  EmailCandidate,
} from "../types";

// ============================================================================
// CONSTANTS
// ============================================================================

const NOW = new Date("2026-04-06T12:00:00Z").getTime();
const ONE_HOUR = 60 * 60 * 1000;

// ============================================================================
// FACTORY HELPERS
// ============================================================================

function hoursAgo(hours: number): string {
  return new Date(NOW - hours * ONE_HOUR).toISOString();
}

function daysAgo(days: number): string {
  return new Date(NOW - days * 24 * ONE_HOUR).toISOString();
}

let idCounter = 0;

function makeUser(overrides: Partial<UserData> = {}): UserData {
  idCounter++;
  return {
    userId: `user-${idCounter}`,
    email: `user${idCounter}@test.com`,
    createdAt: hoursAgo(2),
    emailConfirmedAt: hoursAgo(2),
    ...overrides,
  };
}

function makeSettings(
  userId: string,
  overrides: Partial<Omit<UserSettingsData, "userId">> = {}
): UserSettingsData {
  return {
    userId,
    phone: { number: "+1234567890" },
    imapHost: "imap.gmail.com",
    pinHash: "abc123",
    callSchedule: null,
    updatedAt: hoursAgo(2),
    ...overrides,
  };
}

function makeSession(
  userId: string,
  startedAt: string
): SessionData {
  return { userId, startedAt };
}

function makeSent(
  userId: string,
  emailType: string,
  sentAt?: string
): SentEmailData {
  return { userId, emailType, sentAt: sentAt ?? hoursAgo(48) };
}

// ============================================================================
// SETUP
// ============================================================================

beforeEach(() => {
  idCounter = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// TESTS
// ============================================================================

describe("filterIncompleteOnboarding", () => {
  it("produces candidates based on wide time windows and skips already-sent", () => {
    // User signed up 73h ago, missing phone -- eligible for all 3 emails
    const userA = makeUser({ createdAt: hoursAgo(73) });
    const settingsA = makeSettings(userA.userId, { phone: null });

    // User signed up 30min ago, missing imap -- too early for any email
    const userB = makeUser({ createdAt: hoursAgo(0.5) });
    const settingsB = makeSettings(userB.userId, { imapHost: null });

    // User with complete onboarding -- should not appear
    const userC = makeUser({ createdAt: hoursAgo(73) });
    const settingsC = makeSettings(userC.userId);

    // User with unconfirmed email -- should not appear
    const userD = makeUser({ createdAt: hoursAgo(73), emailConfirmedAt: null });
    const settingsD = makeSettings(userD.userId, { pinHash: null });

    // userA already received the 1h email
    const sent = [makeSent(userA.userId, "onboarding_incomplete_1h")];

    const result = filterIncompleteOnboarding(
      [userA, userB, userC, userD],
      [settingsA, settingsB, settingsC, settingsD],
      sent
    );

    const types = result.map((c) => `${c.userId}:${c.emailType}`);
    // userA gets 24h and 72h (1h was already sent)
    expect(types).toContain(`${userA.userId}:onboarding_incomplete_24h`);
    expect(types).toContain(`${userA.userId}:onboarding_incomplete_72h`);
    expect(types).not.toContain(`${userA.userId}:onboarding_incomplete_1h`);
    // userB, userC, userD should not appear
    expect(result.every((c) => c.userId === userA.userId)).toBe(true);
  });
});

describe("filterGetStarted", () => {
  it("produces the right emails based on time since onboarding, session count, and schedule", () => {
    // User completed onboarding 4 days ago, 0 sessions, no schedule
    // Should get: welcome, no_call_nudge_24h, no_call_nudge_72h, schedule_nudge
    const userA = makeUser();
    const settingsA = makeSettings(userA.userId, { updatedAt: daysAgo(4) });

    // User completed onboarding 48h ago, has session 25h ago
    // Should get: welcome, first_call_followup
    const userB = makeUser();
    const settingsB = makeSettings(userB.userId, { updatedAt: hoursAgo(48) });
    const sessionB = makeSession(userB.userId, hoursAgo(25));

    // Incomplete onboarding -- should not appear
    const userC = makeUser();
    const settingsC = makeSettings(userC.userId, { phone: null, updatedAt: daysAgo(4) });

    const result = filterGetStarted(
      [userA, userB, userC],
      [settingsA, settingsB, settingsC],
      [sessionB],
      []
    );

    const typesA = result.filter((c) => c.userId === userA.userId).map((c) => c.emailType);
    expect(typesA).toContain("welcome");
    expect(typesA).toContain("no_call_nudge_24h");
    expect(typesA).toContain("no_call_nudge_72h");
    expect(typesA).toContain("schedule_nudge");

    const typesB = result.filter((c) => c.userId === userB.userId).map((c) => c.emailType);
    expect(typesB).toContain("welcome");
    expect(typesB).toContain("first_call_followup");
    expect(typesB).not.toContain("no_call_nudge_24h");

    expect(result.find((c) => c.userId === userC.userId)).toBeUndefined();
  });

  it("skips schedule_nudge when callSchedule is set", () => {
    const user = makeUser();
    const settings = makeSettings(user.userId, {
      updatedAt: daysAgo(4),
      callSchedule: { days: ["mon"] },
    });

    const result = filterGetStarted([user], [settings], [], []);
    const types = result.map((c) => c.emailType);
    expect(types).not.toContain("schedule_nudge");
  });
});

describe("filterReactivation", () => {
  it("targets users whose most recent session is 3d+ ago", () => {
    // Last session 4d ago -- eligible
    const userA = makeUser();
    const settingsA = makeSettings(userA.userId);

    // Two sessions: most recent is 1d ago -- not eligible (uses most recent)
    const userB = makeUser();
    const settingsB = makeSettings(userB.userId);

    const result = filterReactivation(
      [userA, userB],
      [settingsA, settingsB],
      [
        makeSession(userA.userId, daysAgo(4)),
        makeSession(userB.userId, daysAgo(10)),
        makeSession(userB.userId, daysAgo(1)),
      ],
      []
    );

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe(userA.userId);
    expect(result[0].emailType).toBe("reengagement_3d");
  });
});

describe("filterUpgrade", () => {
  it("targets free users with 3+ sessions who signed up 14d+ ago", () => {
    // Eligible
    const userA = makeUser({ createdAt: daysAgo(15) });
    const settingsA = makeSettings(userA.userId);

    // Pro plan -- not eligible
    const userB = makeUser({ createdAt: daysAgo(15) });
    const settingsB = makeSettings(userB.userId);

    // Only 2 sessions -- not eligible
    const userC = makeUser({ createdAt: daysAgo(15) });
    const settingsC = makeSettings(userC.userId);

    const result = filterUpgrade(
      [userA, userB, userC],
      [settingsA, settingsB, settingsC],
      [
        makeSession(userA.userId, daysAgo(10)),
        makeSession(userA.userId, daysAgo(7)),
        makeSession(userA.userId, daysAgo(3)),
        makeSession(userB.userId, daysAgo(10)),
        makeSession(userB.userId, daysAgo(7)),
        makeSession(userB.userId, daysAgo(3)),
        makeSession(userC.userId, daysAgo(10)),
        makeSession(userC.userId, daysAgo(7)),
      ],
      [
        { userId: userA.userId, plan: "free" as const },
        { userId: userB.userId, plan: "pro" as const },
        { userId: userC.userId, plan: "free" as const },
      ],
      []
    );

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe(userA.userId);
  });
});

describe("prioritizeCandidates", () => {
  it("keeps one email per user, respecting path and within-path priority", () => {
    const candidates: EmailCandidate[] = [
      // user1: P3 and P2 emails -- should keep P2 (welcome)
      { userId: "u1", email: "u1@test.com", emailType: "reengagement_3d" },
      { userId: "u1", email: "u1@test.com", emailType: "welcome" },
      // user2: within P1, should keep 1a over 1c
      { userId: "u2", email: "u2@test.com", emailType: "onboarding_incomplete_72h" },
      { userId: "u2", email: "u2@test.com", emailType: "onboarding_incomplete_1h" },
      // user3: single candidate, kept as-is
      { userId: "u3", email: "u3@test.com", emailType: "upgrade_nudge" },
    ];

    const result = prioritizeCandidates(candidates);

    expect(result).toHaveLength(3);
    expect(result.find((c) => c.userId === "u1")!.emailType).toBe("welcome");
    expect(result.find((c) => c.userId === "u2")!.emailType).toBe("onboarding_incomplete_1h");
    expect(result.find((c) => c.userId === "u3")!.emailType).toBe("upgrade_nudge");
  });
});

describe("applyCooldown", () => {
  it("blocks users emailed within 24h regardless of email type, passes others through", () => {
    const candidates: EmailCandidate[] = [
      { userId: "u1", email: "u1@test.com", emailType: "welcome" },
      { userId: "u2", email: "u2@test.com", emailType: "welcome" },
      { userId: "u3", email: "u3@test.com", emailType: "upgrade_nudge" },
    ];
    const sent: SentEmailData[] = [
      // u1 emailed 2h ago (different type) -- blocked
      { userId: "u1", emailType: "onboarding_incomplete_1h", sentAt: hoursAgo(2) },
      // u2 emailed 25h ago -- passes
      { userId: "u2", emailType: "onboarding_incomplete_1h", sentAt: hoursAgo(25) },
      // u3 has no sent emails -- passes
    ];

    const result = applyCooldown(candidates, sent);

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.userId)).toEqual(["u2", "u3"]);
  });
});
