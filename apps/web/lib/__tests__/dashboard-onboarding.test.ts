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
  it("treats phone, inbox, and pin as the required onboarding steps", () => {
    const state = getDashboardOnboardingState(
      makeSettings({
        phone: { number: "+15551234567", countryCode: "US" },
        hasPin: true,
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
    expect(state.requiredCompleted).toBe(2);
    expect(state.requiredTotal).toBe(3);
    expect(state.primaryHref).toBe("/dashboard/settings?tab=email");
    expect(state.primaryLabel).toBe("Connect inbox");
  });

  it("marks onboarding complete when phone, connected inbox, and pin are all present", () => {
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
        phone: { number: "+15551234567", countryCode: "US" },
        hasPin: true,
      })
    );

    expect(state.isComplete).toBe(true);
    expect(state.requiredCompleted).toBe(3);
    expect(state.primaryHref).toBe("/dashboard/settings");
    expect(state.primaryLabel).toBe("Open settings");
  });

  it("does not mark the optional schedule step complete when only timezone is stored", () => {
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

    expect(state.steps.find((step) => step.id === "schedule")?.complete).toBe(false);
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
        phone: { number: "+15551234567", countryCode: "US" },
        hasPin: true,
      }),
      "reconnect_required"
    );

    expect(state.isComplete).toBe(false);
    expect(state.primaryHref).toBe("/dashboard/settings?tab=email");
    expect(state.primaryLabel).toBe("Reconnect inbox");
    expect(state.steps.find((step) => step.id === "email")?.complete).toBe(false);
  });
});
