/**
 * Settings page for configuring email, phone, voice, and tool approvals.
 *
 * Client-side form that loads current settings on mount and saves via
 * API routes. Includes sections for IMAP config, SMTP config, phone
 * number, PIN, voice preference, tool approval toggles, and memory entries.
 *
 * Responsibilities:
 * - Load current settings from GET /api/user/settings
 * - Save settings via PUT /api/user/settings
 * - Save phone number via PUT /api/user/phone
 * - Load/save memory entries via GET/PUT /api/memory
 * - Display validation errors
 */

"use client";

import { useState, useEffect } from "react";
import type { UserSettings, MemoryEntry } from "@/lib/types";
import type { ToolApprovalConfig, ActionClassification } from "@dublin/tools/src/types";

// ============================================================================
// CONSTANTS
// ============================================================================

const VOICE_OPTIONS = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

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
// EVENT HANDLERS
// ============================================================================

/**
 * Fetches the current user settings from the API.
 * @returns The user settings
 */
async function fetchSettings(): Promise<UserSettings> {
  const res = await fetch("/api/user/settings");
  if (!res.ok) {
    throw new Error("Failed to load settings");
  }
  return res.json();
}

/**
 * Fetches the current memory entries from the API.
 * @returns Array of memory entries
 */
async function fetchMemory(): Promise<MemoryEntry[]> {
  const res = await fetch("/api/memory");
  if (!res.ok) {
    throw new Error("Failed to load memory");
  }
  return res.json();
}

/**
 * Saves settings to the API.
 * @param data - The settings form data
 * @returns The updated settings
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

/**
 * Saves phone number to the API.
 * @param phoneNumber - The phone number to save
 */
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

/**
 * Saves memory entries to the API.
 * @param entries - The memory entries to save
 */
async function saveMemory(entries: MemoryEntry[]): Promise<void> {
  const res = await fetch("/api/memory", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error || "Failed to save memory");
  }
}

// ============================================================================
// COMPONENT
// ============================================================================

export default function SettingsPage() {
  // Form state
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(993);
  const [imapUser, setImapUser] = useState("");
  const [imapPassword, setImapPassword] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [pin, setPin] = useState("");
  const [voicePreference, setVoicePreference] = useState("alloy");
  const [toolApprovalConfig, setToolApprovalConfig] = useState<ToolApprovalConfig>({});
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([]);
  const [hasImapPassword, setHasImapPassword] = useState(false);
  const [hasSmtpPassword, setHasSmtpPassword] = useState(false);
  const [hasPin, setHasPin] = useState(false);

  // UI state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load settings on mount
  useEffect(() => {
    async function load() {
      try {
        const [settings, memory] = await Promise.all([fetchSettings(), fetchMemory()]);

        setImapHost(settings.imapHost);
        setImapPort(settings.imapPort);
        setImapUser(settings.imapUser);
        setHasImapPassword(settings.hasImapPassword);
        setSmtpHost(settings.smtpHost);
        setSmtpPort(settings.smtpPort);
        setSmtpUser(settings.smtpUser);
        setHasSmtpPassword(settings.hasSmtpPassword);
        setPhoneNumber(settings.phoneNumber ?? "");
        setHasPin(settings.hasPin);
        setVoicePreference(settings.voicePreference);
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

  /**
   * Handles form submission for settings + phone + memory.
   * @param e - The form submit event
   */
  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      // Save settings
      const settingsPayload: Record<string, unknown> = {
        imapHost,
        imapPort,
        imapUser,
        smtpHost,
        smtpPort,
        smtpUser,
        voicePreference,
        toolApprovalConfig,
      };
      // Only include passwords if the user entered new ones
      if (imapPassword) settingsPayload.imapPassword = imapPassword;
      if (smtpPassword) settingsPayload.smtpPassword = smtpPassword;
      if (pin) settingsPayload.pin = pin;

      await saveSettings(settingsPayload);

      // Save phone number
      if (phoneNumber) {
        await savePhoneNumber(phoneNumber);
      }

      // Save memory entries (filter out empty entries)
      const validEntries = memoryEntries.filter((e) => e.key.trim() !== "");
      await saveMemory(validEntries);

      setSuccess("Settings saved successfully.");
      // Clear password fields after save
      setImapPassword("");
      setSmtpPassword("");
      setPin("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Updates a tool approval config entry.
   * @param toolName - The tool to update
   * @param classification - The new classification
   */
  function handleToolApprovalChange(toolName: string, classification: ActionClassification) {
    setToolApprovalConfig((prev) => ({ ...prev, [toolName]: classification }));
  }

  /**
   * Adds a new empty memory entry to the list.
   */
  function handleAddMemoryEntry() {
    setMemoryEntries((prev) => [...prev, { key: "", value: "" }]);
  }

  /**
   * Updates a memory entry at the given index.
   * @param index - The index to update
   * @param field - Which field to update
   * @param value - The new value
   */
  function handleMemoryChange(index: number, field: "key" | "value", value: string) {
    setMemoryEntries((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry))
    );
  }

  /**
   * Removes a memory entry at the given index.
   * @param index - The index to remove
   */
  function handleRemoveMemoryEntry(index: number) {
    setMemoryEntries((prev) => prev.filter((_, i) => i !== index));
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  if (loading) {
    return (
      <div>
        <h1 className="mb-8 text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-8 text-2xl font-bold text-gray-900">Settings</h1>

      {error && (
        <div className="mb-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-6 rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-700">
          {success}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-8">
        {/* IMAP Configuration */}
        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">IMAP Configuration</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <InputField label="Host" value={imapHost} onChange={setImapHost} placeholder="imap.gmail.com" />
            <InputField label="Port" type="number" value={String(imapPort)} onChange={(v) => setImapPort(Number(v))} />
            <InputField label="User" value={imapUser} onChange={setImapUser} placeholder="you@gmail.com" />
            <InputField
              label={hasImapPassword ? "Password (leave blank to keep current)" : "Password"}
              type="password"
              value={imapPassword}
              onChange={setImapPassword}
              placeholder={hasImapPassword ? "********" : "App password"}
            />
          </div>
        </section>

        {/* SMTP Configuration */}
        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">SMTP Configuration</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <InputField label="Host" value={smtpHost} onChange={setSmtpHost} placeholder="smtp.gmail.com" />
            <InputField label="Port" type="number" value={String(smtpPort)} onChange={(v) => setSmtpPort(Number(v))} />
            <InputField label="User" value={smtpUser} onChange={setSmtpUser} placeholder="you@gmail.com" />
            <InputField
              label={hasSmtpPassword ? "Password (leave blank to keep current)" : "Password"}
              type="password"
              value={smtpPassword}
              onChange={setSmtpPassword}
              placeholder={hasSmtpPassword ? "********" : "App password"}
            />
          </div>
        </section>

        {/* Phone Number */}
        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Phone Number</h2>
          <InputField
            label="Your phone number (for caller ID authentication)"
            value={phoneNumber}
            onChange={setPhoneNumber}
            placeholder="+1234567890"
          />
        </section>

        {/* PIN */}
        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">PIN</h2>
          <InputField
            label={hasPin ? "Change PIN (4-6 digits, leave blank to keep current)" : "Set PIN (4-6 digits)"}
            type="password"
            value={pin}
            onChange={setPin}
            placeholder={hasPin ? "****" : "1234"}
          />
        </section>

        {/* Voice Preference */}
        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Voice Preference</h2>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Voice</label>
            <select
              value={voicePreference}
              onChange={(e) => setVoicePreference(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {VOICE_OPTIONS.map((voice) => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </select>
          </div>
        </section>

        {/* Tool Approval Toggles */}
        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Tool Approval Settings</h2>
          <p className="mb-4 text-sm text-gray-500">
            Control which actions require manual approval. &quot;send_email&quot; always requires approval.
          </p>
          <div className="space-y-3">
            {TOOL_NAMES.map((toolName) => (
              <div key={toolName} className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">{toolName}</span>
                <select
                  value={toolApprovalConfig[toolName] ?? ""}
                  onChange={(e) =>
                    handleToolApprovalChange(toolName, e.target.value as ActionClassification)
                  }
                  disabled={toolName === "send_email"}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
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
        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Memory Entries</h2>
          <p className="mb-4 text-sm text-gray-500">
            Key-value pairs the assistant remembers across calls.
          </p>
          <div className="space-y-3">
            {memoryEntries.map((entry, index) => (
              <div key={index} className="flex gap-2">
                <input
                  type="text"
                  value={entry.key}
                  onChange={(e) => handleMemoryChange(index, "key", e.target.value)}
                  placeholder="Key"
                  className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <input
                  type="text"
                  value={entry.value}
                  onChange={(e) => handleMemoryChange(index, "value", e.target.value)}
                  placeholder="Value"
                  className="flex-2 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => handleRemoveMemoryEntry(index)}
                  className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={handleAddMemoryEntry}
            className="mt-3 rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Add Entry
          </button>
        </section>

        {/* Save Button */}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

interface InputFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}

/**
 * Simple labeled input field.
 * @param props - Input field properties
 * @returns A labeled input element
 */
function InputField({ label, value, onChange, placeholder, type = "text" }: InputFieldProps) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );
}
