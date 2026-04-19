/**
 * Tests for the settings API route helper logic.
 *
 * Verifies:
 * - mapUserSettingsRowToSettings correctly maps DB rows + email account to UserSettings DTO
 * - mapUserSettingsRowToSettings returns correct defaults when fields are missing
 * - getDefaultUserSettings returns shared defaults for new users (no settings row)
 */

import { describe, it, expect } from "vitest";
import type { UserSettings } from "@/lib/types";
import {
  DEFAULT_SPEED,
  DEFAULT_VOICE,
  getDefaultUserSettings,
  mapUserSettingsRowToSettings,
} from "@/lib/user-settings-defaults";

// ============================================================================
// TESTS
// ============================================================================

describe("mapUserSettingsRowToSettings", () => {
  const fakeEmailAccount: UserSettings["emailAccount"] = {
    id: "acc-1",
    provider: "gmail",
    connectionType: "unipile",
    emailAddress: "user@gmail.com",
    status: "connected",
    lastError: null,
    hasImapPassword: false,
    hasSmtpPassword: false,
  };

  it("maps a complete DB row to UserSettings", () => {
    const row = {
      voice_config: { voice: "aura-2-andromeda-en", speed: 1.5 },
      tool_approval_config: { archive_email: "mutating_auto" },
      phone: { number: "+15551234567", countryCode: "US" },
      pin_hash: "$2a$10$abc",
      call_schedule: { timezone: "America/New_York", monday: "09:00" },
    };

    const result = mapUserSettingsRowToSettings(row, fakeEmailAccount);

    expect(result.emailAccount).toBe(fakeEmailAccount);
    expect(result.voicePreference).toBe("aura-2-andromeda-en");
    expect(result.voiceSpeed).toBe(1.5);
    expect(result.toolApprovalConfig).toEqual({ archive_email: "mutating_auto" });
    expect(result.phone).toEqual({ number: "+15551234567", countryCode: "US" });
    expect(result.hasPin).toBe(true);
    expect(result.callSchedule).toEqual({ timezone: "America/New_York", monday: "09:00" });
  });

  it("returns defaults when optional fields are missing", () => {
    const row = {};

    const result = mapUserSettingsRowToSettings(row, null);

    expect(result.emailAccount).toBeNull();
    expect(result.voicePreference).toBe(DEFAULT_VOICE);
    expect(result.voiceSpeed).toBe(DEFAULT_SPEED);
    expect(result.toolApprovalConfig).toEqual({});
    expect(result.phone).toBeNull();
    expect(result.hasPin).toBe(false);
    expect(result.callSchedule).toBeNull();
  });

  it("hasPin is false when pin_hash is null", () => {
    const row = { pin_hash: null };

    const result = mapUserSettingsRowToSettings(row, null);

    expect(result.hasPin).toBe(false);
  });
});

describe("getDefaultUserSettings", () => {
  it("returns the shared defaults for users with no settings row", () => {
    const result = getDefaultUserSettings(null);

    expect(result.emailAccount).toBeNull();
    expect(result.voicePreference).toBe(DEFAULT_VOICE);
    expect(result.voiceSpeed).toBe(DEFAULT_SPEED);
    expect(result.toolApprovalConfig).toEqual({});
    expect(result.phone).toBeNull();
    expect(result.hasPin).toBe(false);
    expect(result.callSchedule).toBeNull();
  });
});
