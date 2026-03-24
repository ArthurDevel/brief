/**
 * General settings tab -- phone, PIN, voice, tool approvals, memory.
 *
 * - Text input sections (phone, PIN): show a Save button when there are pending changes
 * - Selectors, sliders, dropdowns (voice, speed, tool approvals): auto-save on change
 * - Memory entries: save/delete immediately via their own buttons
 */

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { UserSettings, MemoryEntry } from "@/lib/types";
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

async function savePhoneNumber(phoneNumber: string): Promise<void> {
  const res = await fetch("/api/user/phone", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneNumber }),
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error || "Failed to save phone number");
  }
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
  const [phoneNumber, setPhoneNumber] = useState("");
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

  // Saved state for detecting pending text changes
  const [savedPhone, setSavedPhone] = useState("");

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
        const [settings, memory, voiceList] = await Promise.all([
          fetchSettings(),
          fetchMemory(),
          fetchVoices(),
        ]);
        setVoices(voiceList);
        setPhoneNumber(settings.phoneNumber ?? "");
        setHasPin(settings.hasPin);
        setVoicePreference(settings.voicePreference);
        setVoiceSpeed(settings.voiceSpeed ?? 1.0);
        setToolApprovalConfig(settings.toolApprovalConfig);
        setMemoryEntries(memory);
        setSavedPhone(settings.phoneNumber ?? "");
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
  const phoneDirty = phoneNumber !== savedPhone;
  const pinDirty = pin !== "";

  // Section save handlers
  async function handleSavePhone() {
    setSavingSection("phone");
    setError(null);
    try {
      await savePhoneNumber(phoneNumber);
      setSavedPhone(phoneNumber);
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
    return <p className="text-gray-500">Loading...</p>;
  }

  return (
    <div>
      {error && (
        <div className="mb-6 border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-8">
        {/* Phone Number */}
        <section className="border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-bold text-black">Phone Number</h2>
          <InputField
            label="Your phone number (for caller ID authentication)"
            value={phoneNumber}
            onChange={setPhoneNumber}
            placeholder="+1234567890"
          />
          <div className="mt-4 flex justify-end">
            {phoneDirty ? (
              <SectionSaveButton onClick={handleSavePhone} saving={savingSection === "phone"} />
            ) : savedSection === "phone" ? (
              <span className="bg-green-100 px-3 py-1 text-sm font-medium text-green-700">Saved</span>
            ) : null}
          </div>
        </section>

        {/* PIN */}
        <section className="border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-bold text-black">PIN</h2>
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
              <span className="bg-green-100 px-3 py-1 text-sm font-medium text-green-700">Saved</span>
            ) : null}
          </div>
        </section>

        {/* Voice Preference */}
        <section className="border border-gray-200 bg-white p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-black">Voice Preference</h2>
            {savedSection === "voice" && <span className="bg-green-100 px-3 py-1 text-sm font-medium text-green-700">Saved</span>}
          </div>
          {voices.length === 0 ? (
            <p className="text-sm text-gray-500">Loading voices...</p>
          ) : (
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {voices.map((voice) => (
                <label
                  key={voice.canonicalName}
                  className={`flex items-center gap-3 border p-3 cursor-pointer transition-colors ${
                    voicePreference === voice.canonicalName
                      ? "border-black bg-black/5"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="voicePreference"
                    value={voice.canonicalName}
                    checked={voicePreference === voice.canonicalName}
                    onChange={() => handleVoiceChange(voice.canonicalName)}
                    className="accent-black"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-gray-900 capitalize">{voice.name}</span>
                    <span className="ml-2 text-xs text-gray-500">
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
                      className="shrink-0 border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
                    >
                      {playingVoice === voice.canonicalName ? "Stop" : "Preview"}
                    </button>
                  )}
                </label>
              ))}
            </div>
          )}
        </section>

        {/* Voice Speed */}
        <section className="border border-gray-200 bg-white p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-black">Voice Speed</h2>
            {savedSection === "speed" && <span className="bg-green-100 px-3 py-1 text-sm font-medium text-green-700">Saved</span>}
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500 w-10">1x</span>
            <input
              type="range"
              min={1}
              max={1.5}
              step={0.05}
              value={voiceSpeed}
              onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
              className="flex-1 accent-black"
            />
            <span className="text-sm text-gray-500 w-12">1.5x</span>
            <span className="text-sm font-medium text-gray-900 w-12 text-right">{voiceSpeed.toFixed(2)}x</span>
            <button
              type="button"
              onClick={handleSpeedPreview}
              disabled={!voices.find((v) => v.canonicalName === voicePreference)?.sampleUrl}
              className="shrink-0 border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              {previewingSpeed ? "Stop" : "Preview"}
            </button>
          </div>
        </section>

        {/* Tool Approval Toggles */}
        <section className="border border-gray-200 bg-white p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-black">Tool Approval Settings</h2>
            {savedSection === "tools" && <span className="bg-green-100 px-3 py-1 text-sm font-medium text-green-700">Saved</span>}
          </div>
          <p className="mb-4 text-sm text-gray-500">
            Control which actions require manual approval. &quot;send_email&quot; always requires approval.
          </p>
          <div className="space-y-3">
            {TOOL_NAMES.map((toolName) => (
              <div key={toolName} className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">{TOOL_LABELS[toolName] ?? toolName}</span>
                <select
                  value={toolApprovalConfig[toolName] ?? ""}
                  onChange={(e) =>
                    handleToolApprovalChange(toolName, e.target.value as ActionClassification)
                  }
                  disabled={toolName === "send_email"}
                  className="border border-gray-300 px-3 py-1.5 text-sm focus:border-black focus:outline-none focus:ring-1 focus:ring-black disabled:bg-gray-100 disabled:text-gray-500"
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
        <section className="border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-bold text-black">Memory Entries</h2>
          <p className="mb-4 text-sm text-gray-500">
            Things the assistant remembers about you across calls.
          </p>

          <div className="mb-4 flex gap-2">
            <textarea
              value={newMemoryContent}
              onChange={(e) => setNewMemoryContent(e.target.value)}
              placeholder="Add something for the assistant to remember..."
              rows={2}
              className="flex-1 border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
            />
            <button
              type="button"
              onClick={handleAddMemoryEntry}
              className="self-end border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Add
            </button>
          </div>

          <div className="space-y-3">
            {memoryEntries.map((entry) => (
              <div key={entry.id} className="flex items-start gap-2 border border-gray-200 p-3">
                <p className="flex-1 whitespace-pre-wrap text-sm text-gray-700">{entry.content}</p>
                <button
                  type="button"
                  onClick={() => handleDeleteMemoryEntry(entry.id)}
                  className="shrink-0 border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            ))}
            {memoryEntries.length === 0 && (
              <p className="text-sm text-gray-400">No memory entries yet.</p>
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
      className="bg-black px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
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
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
      />
    </div>
  );
}
