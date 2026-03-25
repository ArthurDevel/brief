/**
 * General settings tab -- phone, PIN, voice, tool approvals, memory.
 *
 * - Text input sections (phone, PIN): show a Save button when there are pending changes
 * - Selectors, sliders, dropdowns (voice, speed, tool approvals): auto-save on change
 * - Memory entries: save/delete immediately via their own buttons
 */

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { parsePhoneNumber } from "libphonenumber-js";
import type { UserSettings, MemoryEntry, CompanyPhone } from "@/lib/types";
import type { ToolApprovalConfig, ActionClassification } from "@dublin/tools/src/types";
import { TOOL_LABELS } from "@dublin/tools/src/definitions";
import type { DeepgramVoice } from "@/app/api/deepgram/voices/route";

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_VOICE = "aura-2-helena-en";

const TOOL_NAMES = [
  "mark_as_read",
  "archive_email",
  "draft_email",
  "delete_email",
  "send_email",
] as const;

const CLASSIFICATION_OPTIONS: ActionClassification[] = [
  "read_only",
  "mutating_auto",
  "mutating_queued",
];

/** Curated list of common countries for the country dropdown. */
const COUNTRY_OPTIONS: { code: string; label: string }[] = [
  { code: "US", label: "United States" },
  { code: "BE", label: "Belgium" },
  { code: "GB", label: "United Kingdom" },
  { code: "DE", label: "Germany" },
  { code: "FR", label: "France" },
  { code: "NL", label: "Netherlands" },
  { code: "ES", label: "Spain" },
  { code: "IT", label: "Italy" },
  { code: "AU", label: "Australia" },
  { code: "CA", label: "Canada" },
];

// ============================================================================
// TYPES
// ============================================================================

/** Form state for the phone number + country fields. */
interface PhoneFormState {
  number: string;
  countryCode: string;
}

// ============================================================================
// API HELPERS
// ============================================================================

async function fetchSettings(): Promise<UserSettings> {
  const res = await fetch("/api/user/settings");
  if (!res.ok) throw new Error("Failed to load settings");
  return res.json();
}

async function fetchVoices(): Promise<DeepgramVoice[]> {
  const res = await fetch("/api/deepgram/voices");
  if (!res.ok) throw new Error("Failed to load voices");
  return res.json();
}

async function fetchMemory(): Promise<MemoryEntry[]> {
  const res = await fetch("/api/memory");
  if (!res.ok) throw new Error("Failed to load memory");
  return res.json();
}

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

/**
 * Save the user's phone number and country code.
 * @param phone - The phone form state with number and countryCode
 */
async function savePhone(phone: PhoneFormState): Promise<void> {
  const res = await fetch("/api/user/phone", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ number: phone.number, countryCode: phone.countryCode }),
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error || "Failed to save phone number");
  }
}

/**
 * Fetch active company phone numbers for the current environment.
 * @returns Array of active company phones
 */
async function fetchCompanyPhones(): Promise<CompanyPhone[]> {
  const res = await fetch("/api/company-phones");
  if (!res.ok) throw new Error("Failed to load company phone numbers");
  return res.json();
}

async function createMemoryEntry(content: string): Promise<MemoryEntry> {
  const res = await fetch("/api/memory", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error || "Failed to create memory entry");
  }
  return res.json();
}

async function deleteMemoryEntry(id: string): Promise<void> {
  const res = await fetch("/api/memory", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error || "Failed to delete memory entry");
  }
}

// ============================================================================
// COMPONENT
// ============================================================================

export default function GeneralTab() {
  // Form state
  const [phone, setPhone] = useState<PhoneFormState>({ number: "", countryCode: "" });
  const [pin, setPin] = useState("");
  const [voicePreference, setVoicePreference] = useState(DEFAULT_VOICE);
  const [voiceSpeed, setVoiceSpeed] = useState(1.0);
  const [voices, setVoices] = useState<DeepgramVoice[]>([]);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [previewingSpeed, setPreviewingSpeed] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [toolApprovalConfig, setToolApprovalConfig] = useState<ToolApprovalConfig>({});
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([]);
  const [newMemoryContent, setNewMemoryContent] = useState("");
  const [hasPin, setHasPin] = useState(false);
  const [companyPhones, setCompanyPhones] = useState<CompanyPhone[]>([]);

  // Saved state for detecting pending text changes
  const [savedPhone, setSavedPhone] = useState<PhoneFormState>({ number: "", countryCode: "" });

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedSection, setSavedSection] = useState<string | null>(null);
  const [savingSection, setSavingSection] = useState<string | null>(null);

  // Ref to always have latest form values for auto-save without stale closures
  const formRef = useRef({
    voicePreference: DEFAULT_VOICE, voiceSpeed: 1.0,
    toolApprovalConfig: {} as ToolApprovalConfig,
  });
  // Keep ref in sync
  formRef.current = {
    voicePreference, voiceSpeed,
    toolApprovalConfig,
  };

  // Auto-save: fire a settings PUT with current form values, flash "Saved"
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const autoSave = useCallback(async (overrides?: Record<string, unknown>, section?: string) => {
    const f = formRef.current;
    const payload: Record<string, unknown> = {
      voicePreference: f.voicePreference,
      voiceSpeed: f.voiceSpeed,
      toolApprovalConfig: f.toolApprovalConfig,
      ...overrides,
    };
    try {
      await saveSettings(payload);
      if (section) {
        setSavedSection(section);
        clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSavedSection(null), 1500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  }, []);

  // Load settings on mount
  useEffect(() => {
    async function load() {
      try {
        const [settings, memory, voiceList, phones] = await Promise.all([
          fetchSettings(),
          fetchMemory(),
          fetchVoices(),
          fetchCompanyPhones(),
        ]);
        setCompanyPhones(phones);
        setVoices(voiceList);

        // Load phone from settings (now a UserPhone object or null)
        const loadedPhone: PhoneFormState = settings.phone
          ? { number: settings.phone.number, countryCode: settings.phone.countryCode }
          : { number: "", countryCode: "" };
        setPhone(loadedPhone);
        setSavedPhone(loadedPhone);

        setHasPin(settings.hasPin);
        setVoicePreference(settings.voicePreference);
        setVoiceSpeed(settings.voiceSpeed ?? 1.0);
        setToolApprovalConfig(settings.toolApprovalConfig);
        setMemoryEntries(memory);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load settings");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Stop audio previews on unmount (e.g. navigating away)
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // Pending change detection
  const phoneDirty = phone.number !== savedPhone.number || phone.countryCode !== savedPhone.countryCode;
  const phoneUnsupported = savedPhone.countryCode !== "" && !companyPhones.some((p) => p.countryCode === savedPhone.countryCode);
  const pinDirty = pin !== "";

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  /**
   * Handle phone number input change. Auto-detects country from the phone prefix.
   * @param value - The raw phone number string
   */
  function handlePhoneNumberChange(value: string): void {
    let detectedCountry = phone.countryCode;

    // Try to auto-detect country from the phone number prefix
    try {
      const parsed = parsePhoneNumber(value);
      if (parsed?.country) {
        detectedCountry = parsed.country;
      }
    } catch {
      // Not a valid phone number yet -- keep existing country
    }

    setPhone({ number: value, countryCode: detectedCountry });
  }

  /**
   * Handle manual country dropdown change.
   * @param countryCode - The selected ISO 3166-1 alpha-2 country code
   */
  function handleCountryChange(countryCode: string): void {
    setPhone((prev) => ({ ...prev, countryCode }));
  }

  async function handleSavePhone(): Promise<void> {
    setSavingSection("phone");
    setError(null);

    // Validate that the selected country matches the phone number
    try {
      const parsed = parsePhoneNumber(phone.number);
      if (parsed?.country && parsed.country !== phone.countryCode) {
        setError(`Phone number belongs to ${parsed.country}, not ${phone.countryCode}.`);
        setSavingSection(null);
        return;
      }
    } catch {
      // If parsing fails, the number is likely invalid
      setError("Invalid phone number format.");
      setSavingSection(null);
      return;
    }

    try {
      await savePhone(phone);
      setSavedPhone(phone);
      setSavedSection("phone");
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSavedSection(null), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save phone number");
    } finally {
      setSavingSection(null);
    }
  }

  async function handleSavePin() {
    setSavingSection("pin");
    setError(null);
    try {
      await autoSave({ pin }, "pin");
      setHasPin(true);
      setPin("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save PIN");
    } finally {
      setSavingSection(null);
    }
  }

  // Instant-save handlers for non-text controls
  function handleVoiceChange(canonicalName: string) {
    setVoicePreference(canonicalName);
    autoSave({ voicePreference: canonicalName }, "voice");
  }

  const speedDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  function handleSpeedChange(speed: number) {
    setVoiceSpeed(speed);
    if (audioRef.current) {
      audioRef.current.playbackRate = speed;
    }
    clearTimeout(speedDebounceRef.current);
    speedDebounceRef.current = setTimeout(() => {
      autoSave({ voiceSpeed: speed }, "speed");
    }, 400);
  }

  function handleToolApprovalChange(toolName: string, classification: ActionClassification) {
    const updated = { ...toolApprovalConfig, [toolName]: classification };
    setToolApprovalConfig(updated);
    autoSave({ toolApprovalConfig: updated }, "tools");
  }

  // Audio preview handlers
  function handlePlayPreview(canonicalName: string, sampleUrl: string) {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (playingVoice === canonicalName) {
      setPlayingVoice(null);
      return;
    }
    const audio = new Audio(sampleUrl);
    audio.playbackRate = voiceSpeed;
    audio.onended = () => setPlayingVoice(null);
    audio.play();
    audioRef.current = audio;
    setPlayingVoice(canonicalName);
  }

  function handleSpeedPreview() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setPlayingVoice(null);
    }
    if (previewingSpeed) {
      setPreviewingSpeed(false);
      return;
    }
    const selectedVoice = voices.find((v) => v.canonicalName === voicePreference);
    if (!selectedVoice?.sampleUrl) return;
    const audio = new Audio(selectedVoice.sampleUrl);
    audio.playbackRate = voiceSpeed;
    audio.onended = () => {
      setPreviewingSpeed(false);
      audioRef.current = null;
    };
    audio.play();
    audioRef.current = audio;
    setPreviewingSpeed(true);
  }

  // Memory handlers
  async function handleAddMemoryEntry() {
    if (!newMemoryContent.trim()) return;
    try {
      setError(null);
      const entry = await createMemoryEntry(newMemoryContent.trim());
      setMemoryEntries((prev) => [entry, ...prev]);
      setNewMemoryContent("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create memory entry");
    }
  }

  async function handleDeleteMemoryEntry(id: string) {
    try {
      setError(null);
      await deleteMemoryEntry(id);
      setMemoryEntries((prev) => prev.filter((entry) => entry.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete memory entry");
    }
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  if (loading) {
    return <p className="text-[var(--text-secondary)]">Loading...</p>;
  }

  return (
    <div>
      {error && (
        <div className="mb-6 border border-red-200 bg-red-50 p-4 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <div>
        {/* Phone Number */}
        <section className="settings-panel">
          <h2>Phone Number</h2>
          <div className="flex gap-3">
            <div className="w-48">
              <label className="mb-1 block text-[13px] font-medium text-[var(--text-secondary)]">Country</label>
              <select
                value={phone.countryCode}
                onChange={(e) => handleCountryChange(e.target.value)}
                className="w-full border border-[var(--border-color)] px-3 py-2 text-[13px] focus:border-[var(--btn-primary-bg)] focus:outline-none focus:ring-1 focus:ring-[var(--btn-primary-bg)]"
              >
                <option value="">-- Select --</option>
                {COUNTRY_OPTIONS.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label} ({c.code})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <InputField
                label="Your phone number (for caller ID authentication)"
                value={phone.number}
                onChange={handlePhoneNumberChange}
                placeholder="+1234567890"
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            {phoneDirty ? (
              <SectionSaveButton onClick={handleSavePhone} saving={savingSection === "phone"} />
            ) : savedSection === "phone" ? (
              <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">Saved</span>
            ) : null}
          </div>
          {phoneUnsupported && (
            <p className="mt-3 text-sm text-red-600">
              Phone calls are not yet available in your country. Supported countries:{" "}
              {companyPhones.map((p) => p.label).join(", ")}.
            </p>
          )}
        </section>

        {/* PIN */}
        <section className="settings-panel">
          <h2 >PIN</h2>
          <InputField
            label={hasPin ? "Change PIN (4-6 digits, leave blank to keep current)" : "Set PIN (4-6 digits)"}
            type="password"
            value={pin}
            onChange={setPin}
            placeholder={hasPin ? "****" : "1234"}
          />
          <div className="mt-4 flex justify-end">
            {pinDirty ? (
              <SectionSaveButton onClick={handleSavePin} saving={savingSection === "pin"} />
            ) : savedSection === "pin" ? (
              <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">Saved</span>
            ) : null}
          </div>
        </section>

        {/* Voice Speed */}
        <section className="settings-panel">
          <div className="mb-4 flex items-center justify-between">
            <h2 >Voice Speed</h2>
            {savedSection === "speed" && <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">Saved</span>}
          </div>
          <div className="flex items-center gap-4">
            <span className="text-[13px] text-[var(--text-secondary)] w-10">1x</span>
            <input
              type="range"
              min={1}
              max={1.5}
              step={0.05}
              value={voiceSpeed}
              onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
              className="flex-1 accent-[var(--btn-primary-bg)]"
            />
            <span className="text-[13px] text-[var(--text-secondary)] w-12">1.5x</span>
            <span className="text-[13px] font-medium text-[var(--text-primary)] w-12 text-right">{voiceSpeed.toFixed(2)}x</span>
            <button
              type="button"
              onClick={handleSpeedPreview}
              disabled={!voices.find((v) => v.canonicalName === voicePreference)?.sampleUrl}
              className="shrink-0 border border-[var(--border-color)] px-3 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            >
              {previewingSpeed ? "Stop" : "Preview"}
            </button>
          </div>
        </section>

        {/* Voice Preference */}
        <section className="settings-panel">
          <div className="mb-4 flex items-center justify-between">
            <h2 >Voice Preference</h2>
            {savedSection === "voice" && <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">Saved</span>}
          </div>
          {voices.length === 0 ? (
            <p className="text-[13px] text-[var(--text-secondary)]">Loading voices...</p>
          ) : (
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {voices.map((voice) => (
                <label
                  key={voice.canonicalName}
                  className={`flex items-center gap-3 border p-3 cursor-pointer transition-colors ${
                    voicePreference === voice.canonicalName
                      ? "border-[var(--btn-primary-bg)] bg-[var(--btn-primary-bg)]/5"
                      : "border-[var(--border-color)] hover:border-[var(--border-color)]"
                  }`}
                >
                  <input
                    type="radio"
                    name="voicePreference"
                    value={voice.canonicalName}
                    checked={voicePreference === voice.canonicalName}
                    onChange={() => handleVoiceChange(voice.canonicalName)}
                    className="accent-[var(--btn-primary-bg)]"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-[13px] font-medium text-[var(--text-primary)] capitalize">{voice.name}</span>
                    <span className="ml-2 text-xs text-[var(--text-secondary)]">
                      English ({voice.accent} accent)
                    </span>
                  </div>
                  {voice.sampleUrl && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        handlePlayPreview(voice.canonicalName, voice.sampleUrl!);
                      }}
                      className="shrink-0 border border-[var(--border-color)] px-3 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                    >
                      {playingVoice === voice.canonicalName ? "Stop" : "Preview"}
                    </button>
                  )}
                </label>
              ))}
            </div>
          )}
        </section>

        {/* Tool Approval Toggles */}
        <section className="settings-panel">
          <div className="mb-4 flex items-center justify-between">
            <h2 >Tool Approval Settings</h2>
            {savedSection === "tools" && <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">Saved</span>}
          </div>
          <p className="mb-4 text-[13px] text-[var(--text-secondary)]">
            Control which actions require manual approval. &quot;send_email&quot; always requires approval.
          </p>
          <div className="space-y-3">
            {TOOL_NAMES.map((toolName) => (
              <div key={toolName} className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-[var(--text-secondary)]">{TOOL_LABELS[toolName] ?? toolName}</span>
                <select
                  value={toolApprovalConfig[toolName] ?? ""}
                  onChange={(e) =>
                    handleToolApprovalChange(toolName, e.target.value as ActionClassification)
                  }
                  disabled={toolName === "send_email"}
                  className="border border-[var(--border-color)] px-3 py-1.5 text-[13px] focus:border-[var(--btn-primary-bg)] focus:outline-none focus:ring-1 focus:ring-[var(--btn-primary-bg)] disabled:bg-[var(--bg-hover)] disabled:text-[var(--text-secondary)]"
                >
                  <option value="">Default</option>
                  {CLASSIFICATION_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </section>

        {/* Memory Entries */}
        <section className="settings-panel">
          <h2 >Memory Entries</h2>
          <p className="mb-4 text-[13px] text-[var(--text-secondary)]">
            Things the assistant remembers about you across calls.
          </p>

          <div className="mb-4 flex gap-2">
            <textarea
              value={newMemoryContent}
              onChange={(e) => setNewMemoryContent(e.target.value)}
              placeholder="Add something for the assistant to remember..."
              rows={2}
              className="flex-1 border border-[var(--border-color)] px-3 py-2 text-[13px] focus:border-[var(--btn-primary-bg)] focus:outline-none focus:ring-1 focus:ring-[var(--btn-primary-bg)]"
            />
            <button
              type="button"
              onClick={handleAddMemoryEntry}
              className="self-end border border-[var(--border-color)] px-4 py-2 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              Add
            </button>
          </div>

          <div className="space-y-3">
            {memoryEntries.map((entry) => (
              <div key={entry.id} className="flex items-start gap-2 border border-[var(--border-color)] p-3">
                <p className="flex-1 whitespace-pre-wrap text-[13px] text-[var(--text-secondary)]">{entry.content}</p>
                <button
                  type="button"
                  onClick={() => handleDeleteMemoryEntry(entry.id)}
                  className="shrink-0 border border-red-300 px-3 py-1 text-[13px] text-red-700 hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            ))}
            {memoryEntries.length === 0 && (
              <p className="text-[13px] text-[var(--text-secondary)]">No memory entries yet.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

function SectionSaveButton({ onClick, saving }: { onClick: () => void; saving: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      className="bg-[var(--btn-primary-bg)] px-4 py-1.5 text-[13px] font-medium text-[var(--btn-primary-text)] hover:bg-[var(--btn-primary-hover)] disabled:opacity-50"
    >
      {saving ? "Saving..." : "Save"}
    </button>
  );
}

interface InputFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}

function InputField({ label, value, onChange, placeholder, type = "text" }: InputFieldProps) {
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium text-[var(--text-secondary)]">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-[var(--border-color)] px-3 py-2 text-[13px] focus:border-[var(--btn-primary-bg)] focus:outline-none focus:ring-1 focus:ring-[var(--btn-primary-bg)]"
      />
    </div>
  );
}
