import { describe, expect, it } from "vitest";
import type { UserSettings } from "@/lib/types";
import { getDashboardOnboardingState } from "../dashboard-onboarding";

function makeSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    emailAccount: null,
    voicePreference: "aura-asteria-en",
    voiceSpeed: 1,
    toolApprovalConfig: {},
    phone: null,
    whatsappPhone: null,
    hasPin: false,
    callSchedule: null,
    ...overrides,
  };
}

describe("getDashboardOnboardingState", () => {
  it("treats inbox setup as the required onboarding step", () => {
    const state = getDashboardOnboardingState(
      makeSettings({
        callSchedule: {
          timezone: "America/Los_Angeles",
          last_call_at: null,
          monday: "08:00",
          tuesday: "08:00",
          wednesday: "08:00",
          thursday: "08:00",
          friday: "08:00",
          saturday: null,
          sunday: null,
        },
      })
    );

    expect(state.isComplete).toBe(false);
    expect(state.requiredCompleted).toBe(0);
    expect(state.requiredTotal).toBe(1);
    expect(state.primaryHref).toBe("/dashboard/settings?tab=email");
    expect(state.primaryLabel).toBe("Connect inbox");
  });

  it("marks onboarding complete when a connected inbox is present", () => {
    const state = getDashboardOnboardingState(
      makeSettings({
        emailAccount: {
          id: "acc_123",
          provider: "gmail",
          connectionType: "unipile",
          emailAddress: "user@example.com",
          status: "connected",
          lastError: null,
          hasImapPassword: false,
          hasSmtpPassword: false,
        },
      })
    );

    expect(state.isComplete).toBe(true);
    expect(state.requiredCompleted).toBe(1);
    expect(state.primaryHref).toBe("/dashboard/settings");
    expect(state.primaryLabel).toBe("Open settings");
  });

  it("only includes the email step", () => {
    const state = getDashboardOnboardingState(
      makeSettings({
        callSchedule: {
          timezone: "America/Los_Angeles",
          last_call_at: null,
          monday: null,
          tuesday: null,
          wednesday: null,
          thursday: null,
          friday: null,
          saturday: null,
          sunday: null,
        },
      })
    );

    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]?.id).toBe("email");
  });

  it("prioritizes reconnecting inboxes before other completed steps when email status is degraded", () => {
    const state = getDashboardOnboardingState(
      makeSettings({
        emailAccount: {
          id: "acc_123",
          provider: "gmail",
          connectionType: "unipile",
          emailAddress: "user@example.com",
          status: "connected",
          lastError: null,
          hasImapPassword: false,
          hasSmtpPassword: false,
        },
      }),
      "reconnect_required"
    );

    expect(state.isComplete).toBe(false);
    expect(state.primaryHref).toBe("/dashboard/settings?tab=email");
    expect(state.primaryLabel).toBe("Reconnect inbox");
    expect(state.steps.find((step) => step.id === "email")?.complete).toBe(false);
  });
});
