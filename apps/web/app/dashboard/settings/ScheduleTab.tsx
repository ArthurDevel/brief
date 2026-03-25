/**
 * Schedule tab -- weekly call schedule picker with timezone selector.
 *
 * Lets the user configure one call time per day of the week and choose their timezone.
 * Auto-saves on every change (toggle, time, timezone) using the same pattern as
 * voice/speed selectors in GeneralTab.
 *
 * Responsibilities:
 * - Render 7 day rows, each with an enabled toggle and a time picker
 * - Render a timezone dropdown (populated from Intl.supportedValuesOf)
 * - Auto-detect browser timezone on first load if timezone is null
 * - Auto-save callSchedule to the settings API on every change
 */

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { UserSettings, CallSchedule } from "@/lib/types";

// ============================================================================
// CONSTANTS
// ============================================================================

const DAY_NAMES = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

type DayName = (typeof DAY_NAMES)[number];

const DAY_LABELS: Record<DayName, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

const DEFAULT_TIME = "09:00";

const TIMEZONES: string[] = Intl.supportedValuesOf("timeZone");

// ============================================================================
// TYPES
// ============================================================================

/** Configuration for a single day in the schedule form. */
interface DayConfig {
  /** Whether calling is enabled for this day */
  enabled: boolean;
  /** Time in "HH:MM" format */
  time: string;
}

/** Local form state for the schedule picker. */
interface ScheduleFormState {
  /** Per-day toggle + time configuration */
  days: Record<DayName, DayConfig>;
  /** IANA timezone string */
  timezone: string;
}

// ============================================================================
// API HELPERS
// ============================================================================

/**
 * Fetch current user settings from the API.
 * @returns the full UserSettings object
 */
async function fetchSettings(): Promise<UserSettings> {
  const res = await fetch("/api/user/settings");
  if (!res.ok) throw new Error("Failed to load settings");
  return res.json();
}

/**
 * Save a partial settings update to the API.
 * @param data - the fields to update
 * @returns the updated UserSettings object
 */
async function saveSettings(data: Record<string, unknown>): Promise<UserSettings> {
  const res = await fetch("/api/user/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error || "Failed to save settings");
  }
  return res.json();
}

// ============================================================================
// CONVERSION HELPERS
// ============================================================================

/**
 * Build initial form state from a CallSchedule (or null for first-time users).
 * @param schedule - the persisted schedule, or null
 * @returns form state with days and timezone populated
 */
function scheduleToFormState(schedule: CallSchedule | null): ScheduleFormState {
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const days = {} as Record<DayName, DayConfig>;
  for (const day of DAY_NAMES) {
    const value = schedule?.[day] ?? null;
    days[day] = {
      enabled: value !== null,
      time: value ?? DEFAULT_TIME,
    };
  }

  return {
    days,
    timezone: schedule?.timezone ?? browserTimezone,
  };
}

/**
 * Convert form state back to a CallSchedule for persistence.
 * Does not set last_call_at -- that is managed by the scheduler.
 * @param state - the current form state
 * @returns a CallSchedule object ready for the API
 */
function formStateToSchedule(state: ScheduleFormState): CallSchedule {
  const schedule: CallSchedule = {
    timezone: state.timezone,
    last_call_at: null,
    monday: null,
    tuesday: null,
    wednesday: null,
    thursday: null,
    friday: null,
    saturday: null,
    sunday: null,
  };

  for (const day of DAY_NAMES) {
    const config = state.days[day];
    schedule[day] = config.enabled ? config.time : null;
  }

  return schedule;
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Weekly schedule picker tab. Renders 7 day rows with toggles and time pickers,
 * plus a timezone selector. Auto-saves on every change.
 */
export default function ScheduleTab() {
  const [formState, setFormState] = useState<ScheduleFormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedSection, setSavedSection] = useState<string | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Ref to hold latest form state for auto-save without stale closures
  const formRef = useRef<ScheduleFormState | null>(null);
  formRef.current = formState;

  // Auto-save: persist the current schedule and flash "Saved" badge
  const autoSave = useCallback(async (updatedState: ScheduleFormState, section: string) => {
    const schedule = formStateToSchedule(updatedState);
    try {
      await saveSettings({ callSchedule: schedule });
      setSavedSection(section);
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSavedSection(null), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save schedule");
    }
  }, []);

  // Load settings on mount
  useEffect(() => {
    async function load() {
      try {
        const settings = await fetchSettings();
        const state = scheduleToFormState(settings.callSchedule);
        setFormState(state);

        // If this is the first visit (no schedule saved), persist the auto-detected timezone
        if (!settings.callSchedule) {
          const schedule = formStateToSchedule(state);
          await saveSettings({ callSchedule: schedule });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load settings");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  /**
   * Toggle a day on or off.
   * @param day - the day to toggle
   */
  function handleDayToggle(day: DayName): void {
    if (!formState) return;
    const updated: ScheduleFormState = {
      ...formState,
      days: {
        ...formState.days,
        [day]: {
          ...formState.days[day],
          enabled: !formState.days[day].enabled,
        },
      },
    };
    setFormState(updated);
    autoSave(updated, "schedule");
  }

  /**
   * Update the time for a specific day.
   * @param day - the day to update
   * @param time - new time in "HH:MM" format
   */
  function handleTimeChange(day: DayName, time: string): void {
    if (!formState) return;
    const updated: ScheduleFormState = {
      ...formState,
      days: {
        ...formState.days,
        [day]: {
          ...formState.days[day],
          time,
        },
      },
    };
    setFormState(updated);
    autoSave(updated, "schedule");
  }

  /**
   * Update the timezone selection.
   * @param timezone - IANA timezone string
   */
  function handleTimezoneChange(timezone: string): void {
    if (!formState) return;
    const updated: ScheduleFormState = {
      ...formState,
      timezone,
    };
    setFormState(updated);
    autoSave(updated, "schedule");
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  if (loading) {
    return <p className="text-[var(--text-secondary)]">Loading...</p>;
  }

  if (!formState) {
    return <p className="text-[var(--text-secondary)]">Loading...</p>;
  }

  return (
    <div>
      {error && (
        <div className="mb-6 border border-red-200 bg-red-50 p-4 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <div className="">
        {/* Timezone */}
        <section className="settings-panel">
          <div className="mb-4 flex items-center justify-between">
            <h2 >Timezone</h2>
            {savedSection === "timezone" && (
              <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">Saved</span>
            )}
          </div>
          <select
            value={formState.timezone}
            onChange={(e) => {
              handleTimezoneChange(e.target.value);
              setSavedSection(null);
            }}
            className="w-full border border-[var(--border-color)] px-3 py-2 text-[13px] focus:border-[var(--btn-primary-bg)] focus:outline-none focus:ring-1 focus:ring-[var(--btn-primary-bg)]"
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">
            All scheduled call times are in this timezone.
          </p>
        </section>

        {/* Weekly Schedule */}
        <section className="settings-panel">
          <div className="mb-4 flex items-center justify-between">
            <h2 >Weekly Schedule</h2>
            {savedSection === "schedule" && (
              <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">Saved</span>
            )}
          </div>
          <p className="mb-4 text-[13px] text-[var(--text-secondary)]">
            Enable a day and pick the time you want to be called.
          </p>

          <div className="space-y-3">
            {DAY_NAMES.map((day) => (
              <DayRow
                key={day}
                label={DAY_LABELS[day]}
                config={formState.days[day]}
                onToggle={() => handleDayToggle(day)}
                onTimeChange={(time) => handleTimeChange(day, time)}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

interface DayRowProps {
  /** Display label for the day */
  label: string;
  /** Current day configuration */
  config: DayConfig;
  /** Called when the toggle is clicked */
  onToggle: () => void;
  /** Called when the time value changes */
  onTimeChange: (time: string) => void;
}

/**
 * A single day row with an enable/disable toggle and a time picker.
 * @param props - label, config, onToggle, onTimeChange
 * @returns JSX for one schedule day row
 */
function DayRow({ label, config, onToggle, onTimeChange }: DayRowProps) {
  return (
    <div className="flex items-center gap-4 border border-[var(--border-color)] p-3">
      {/* Toggle */}
      <button
        type="button"
        onClick={onToggle}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          config.enabled ? "bg-[var(--btn-primary-bg)]" : "bg-[var(--border-color)]"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
            config.enabled ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>

      {/* Day label */}
      <span className="w-28 text-[13px] font-medium text-[var(--text-primary)]">{label}</span>

      {/* Time picker */}
      <input
        type="time"
        value={config.time}
        onChange={(e) => onTimeChange(e.target.value)}
        disabled={!config.enabled}
        className="border border-[var(--border-color)] px-3 py-1.5 text-[13px] focus:border-[var(--btn-primary-bg)] focus:outline-none focus:ring-1 focus:ring-[var(--btn-primary-bg)] disabled:bg-[var(--bg-hover)] disabled:text-[var(--text-secondary)]"
      />
    </div>
  );
}
