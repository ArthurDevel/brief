import sharedDefaults from "../../../shared/user-settings-defaults.json";
import type { CallSchedule, UserPhone, UserSettings } from "@/lib/types";
import type { ToolApprovalConfig } from "@dublin/tools/src/types";

export interface UserSettingsDomainDefaults {
  voice_config: {
    voice: string;
    speed: number;
  };
  tool_approval_config: ToolApprovalConfig;
  phone: UserPhone | null;
  call_schedule: CallSchedule | null;
}

const USER_SETTINGS_DEFAULTS = sharedDefaults as UserSettingsDomainDefaults;

export const DEFAULT_VOICE = USER_SETTINGS_DEFAULTS.voice_config.voice;
export const DEFAULT_SPEED = USER_SETTINGS_DEFAULTS.voice_config.speed;

function cloneDomainDefaults(): UserSettingsDomainDefaults {
  return {
    voice_config: { ...USER_SETTINGS_DEFAULTS.voice_config },
    tool_approval_config: { ...USER_SETTINGS_DEFAULTS.tool_approval_config },
    phone: USER_SETTINGS_DEFAULTS.phone
      ? { ...USER_SETTINGS_DEFAULTS.phone }
      : null,
    call_schedule: USER_SETTINGS_DEFAULTS.call_schedule
      ? { ...USER_SETTINGS_DEFAULTS.call_schedule }
      : null,
  };
}

export function getUserSettingsDomainDefaults(): UserSettingsDomainDefaults {
  return cloneDomainDefaults();
}

export function getDefaultUserSettings(
  emailAccount: UserSettings["emailAccount"]
): UserSettings {
  const defaults = cloneDomainDefaults();

  return {
    emailAccount,
    voicePreference: defaults.voice_config.voice,
    voiceSpeed: defaults.voice_config.speed,
    toolApprovalConfig: defaults.tool_approval_config,
    phone: defaults.phone,
    whatsappPhone: null,
    hasPin: false,
    callSchedule: defaults.call_schedule,
  };
}

export function mapUserSettingsRowToSettings(
  row: Record<string, unknown>,
  emailAccount: UserSettings["emailAccount"]
): UserSettings {
  const defaults = cloneDomainDefaults();
  const voiceConfig = (row.voice_config as Record<string, unknown> | null) ?? {};

  return {
    emailAccount,
    voicePreference:
      typeof voiceConfig.voice === "string"
        ? voiceConfig.voice
        : defaults.voice_config.voice,
    voiceSpeed:
      typeof voiceConfig.speed === "number"
        ? voiceConfig.speed
        : defaults.voice_config.speed,
    toolApprovalConfig:
      (row.tool_approval_config as ToolApprovalConfig | null) ??
      defaults.tool_approval_config,
    phone: (row.phone as UserPhone | null | undefined) ?? defaults.phone,
    whatsappPhone: (row.whatsapp_phone as string | null | undefined) ?? null,
    hasPin: !!row.pin_hash,
    callSchedule:
      (row.call_schedule as CallSchedule | null | undefined) ??
      defaults.call_schedule,
  };
}
