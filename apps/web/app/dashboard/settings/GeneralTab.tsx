/**
 * General settings tab.
 *
 * Responsibilities:
 * - Manage the linked WhatsApp number used by WhatsApp-specific web flows
 * - Manage dashboard action approval behavior
 */

"use client";

import { useEffect, useState } from "react";
import type { UserSettings } from "@/lib/types";
import type { ToolApprovalConfig, ActionClassification } from "@dublin/tools/src/types";
import { TOOL_LABELS } from "@dublin/tools/src/definitions";
import { getDefaultClassification } from "@dublin/tools/src/classification";
import {
  buildDashboardErrorFromResponse,
  logAndMapDashboardError,
} from "@/lib/errors/mapDashboardError";
import {
  SETTINGS_FIELD_CARD,
  SETTINGS_FIELD_LABEL,
  SETTINGS_INPUT,
  SETTINGS_MAX_WIDTH,
  SETTINGS_SECTION_COPY,
} from "./settingsUi";

// ============================================================================
// CONSTANTS
// ============================================================================

const TOOL_NAMES = [
  "mark_as_read",
  "archive_email",
  "move_to_folder",
  "draft_email",
  "delete_email",
  "send_email",
  "reply_email",
] as const;

const CLASSIFICATION_OPTIONS: Array<Exclude<ActionClassification, "read_only">> = [
  "mutating_auto",
  "mutating_queued",
];

const CLASSIFICATION_LABELS: Record<ActionClassification, string> = {
  read_only: "Runs automatically",
  mutating_auto: "Runs automatically",
  mutating_queued: "Requires approval",
};

const CLASSIFICATION_OPTION_LABELS: Record<Exclude<ActionClassification, "read_only">, string> = {
  mutating_auto: "Run automatically",
  mutating_queued: "Require approval",
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Fetches the current user settings.
 * @returns The current settings payload
 */
async function fetchSettings(): Promise<UserSettings> {
  const res = await fetch("/api/user/settings");
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "SETTINGS_LOAD_FAILED",
      error: "Failed to load settings",
    });
  }

  return res.json();
}

/**
 * Persists a partial settings update.
 * @param data - Partial settings payload to save
 * @returns The updated settings payload
 */
async function saveSettings(data: Record<string, unknown>): Promise<UserSettings> {
  const res = await fetch("/api/user/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "SETTINGS_SAVE_FAILED",
      error: "Failed to save settings",
    });
  }

  return res.json();
}

/**
 * Saves the linked WhatsApp phone number.
 * @param phone - WhatsApp phone number in international format
 * @returns The saved WhatsApp phone number
 */
async function saveWhatsAppPhone(phone: string): Promise<{ whatsappPhone: string }> {
  const res = await fetch("/api/user/whatsapp-phone", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });

  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "PHONE_SAVE_FAILED",
      error: "Failed to save WhatsApp phone number",
    });
  }

  return res.json();
}

/**
 * Returns true when a tool must always stay approval-gated.
 * @param toolName - Tool name to inspect
 * @returns Whether the tool is always approval-gated
 */
function isAlwaysApprovalTool(toolName: string): boolean {
  return toolName === "send_email" || toolName === "reply_email";
}

/**
 * Returns the summary label for one action classification.
 * @param classification - Current action classification
 * @returns Human-readable summary label
 */
function getClassificationSummaryLabel(classification: ActionClassification): string {
  return CLASSIFICATION_LABELS[classification];
}

/**
 * Converts an optional classification into the select field value.
 * @param classification - Current classification
 * @returns Empty string for default, otherwise one selectable classification
 */
function getSelectableClassificationValue(
  classification: ActionClassification | undefined
): "" | Exclude<ActionClassification, "read_only"> {
  if (!classification) {
    return "";
  }

  return classification === "mutating_queued" ? "mutating_queued" : "mutating_auto";
}

// ============================================================================
// COMPONENT
// ============================================================================

export default function GeneralTab() {
  const [whatsappPhone, setWhatsappPhone] = useState<string | null>(null);
  const [whatsappPhoneDraft, setWhatsappPhoneDraft] = useState("");
  const [toolApprovalConfig, setToolApprovalConfig] = useState<ToolApprovalConfig>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedSection, setSavedSection] = useState<string | null>(null);
  const [savingSection, setSavingSection] = useState<string | null>(null);

  useEffect(() => {
    async function load(): Promise<void> {
      try {
        const settings = await fetchSettings();
        setWhatsappPhone(settings.whatsappPhone);
        setWhatsappPhoneDraft(settings.whatsappPhone ?? "");
        setToolApprovalConfig(settings.toolApprovalConfig);
      } catch (err) {
        setError(logAndMapDashboardError(err, "settings-general", "SETTINGS_LOAD_FAILED"));
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  const whatsappPhoneDirty = whatsappPhoneDraft !== (whatsappPhone ?? "");

  /**
   * Shows a temporary "Saved" label for one settings section.
   * @param section - Section identifier
   */
  function flashSaved(section: string): void {
    setSavedSection(section);
    window.setTimeout(() => {
      setSavedSection((current) => (current === section ? null : current));
    }, 1500);
  }

  /**
   * Saves the linked WhatsApp phone number.
   * @returns Promise that resolves when the save finishes
   */
  async function handleSaveWhatsAppPhone(): Promise<void> {
    setSavingSection("whatsapp");
    setError(null);

    try {
      const result = await saveWhatsAppPhone(whatsappPhoneDraft);
      setWhatsappPhone(result.whatsappPhone);
      setWhatsappPhoneDraft(result.whatsappPhone);
      flashSaved("whatsapp");
    } catch (err) {
      setError(logAndMapDashboardError(err, "settings-general", "PHONE_SAVE_FAILED"));
    } finally {
      setSavingSection(null);
    }
  }

  /**
   * Saves one action approval setting immediately.
   * @param toolName - Tool name to update
   * @param classification - New classification
   * @returns Promise that resolves when the save finishes
   */
  async function handleToolApprovalChange(
    toolName: string,
    classification: ActionClassification
  ): Promise<void> {
    const updated = { ...toolApprovalConfig, [toolName]: classification };
    setToolApprovalConfig(updated);
    setError(null);

    try {
      await saveSettings({ toolApprovalConfig: updated });
      flashSaved("tools");
    } catch (err) {
      setError(logAndMapDashboardError(err, "settings-general", "SETTINGS_SAVE_FAILED"));
    }
  }

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
        <section className="settings-panel">
          <h2>WhatsApp Access</h2>
          <p className={SETTINGS_SECTION_COPY}>
            Link the WhatsApp number that should open the WhatsApp-specific web flows tied to your
            account.
          </p>
          <div className={SETTINGS_MAX_WIDTH}>
            <label className={SETTINGS_FIELD_LABEL}>Linked WhatsApp number</label>
            <input
              type="tel"
              value={whatsappPhoneDraft}
              onChange={(e) => setWhatsappPhoneDraft(e.target.value)}
              className={SETTINGS_INPUT}
              placeholder="+15551234567"
            />
            <p className="mt-2 text-[13px] text-[var(--text-secondary)]">
              Existing users can link a number here. If someone starts from WhatsApp with an
              unknown number, the auth flow can also create a new Supabase account automatically
              using an internal auth email.
            </p>
          </div>
          <div className="mt-4 flex justify-end">
            {whatsappPhoneDirty ? (
              <SectionSaveButton
                onClick={handleSaveWhatsAppPhone}
                saving={savingSection === "whatsapp"}
              />
            ) : savedSection === "whatsapp" ? (
              <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">
                Saved
              </span>
            ) : null}
          </div>
        </section>

        <section className="settings-panel">
          <div className="mb-4 flex items-center justify-between">
            <h2>Action Approvals</h2>
            {savedSection === "tools" && (
              <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">
                Saved
              </span>
            )}
          </div>
          <p className={SETTINGS_SECTION_COPY}>
            Choose which actions run immediately and which wait for your approval in the dashboard.
            Sending and replying to emails always require approval.
          </p>
          <div className={`${SETTINGS_MAX_WIDTH} space-y-4`}>
            {TOOL_NAMES.map((toolName) => (
              <div key={toolName} className={SETTINGS_FIELD_CARD}>
                <label className={`${SETTINGS_FIELD_LABEL} mb-2`}>
                  {TOOL_LABELS[toolName] ?? toolName}
                </label>
                {isAlwaysApprovalTool(toolName) ? (
                  <span className={`inline-flex w-full items-center ${SETTINGS_INPUT} text-zinc-600`}>
                    Always requires approval
                  </span>
                ) : (
                  <select
                    value={getSelectableClassificationValue(toolApprovalConfig[toolName])}
                    onChange={(e) =>
                      void handleToolApprovalChange(
                        toolName,
                        e.target.value as ActionClassification
                      )
                    }
                    className={SETTINGS_INPUT}
                  >
                    <option value="">
                      Use default ({getClassificationSummaryLabel(getDefaultClassification(toolName))})
                    </option>
                    {CLASSIFICATION_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {CLASSIFICATION_OPTION_LABELS[option]}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Save button used by settings sections with manual submission.
 * @param props.onClick - Click handler for the save action
 * @param props.saving - Whether the save is currently in progress
 * @returns Save button element
 */
function SectionSaveButton({
  onClick,
  saving,
}: {
  onClick: () => void;
  saving: boolean;
}) {
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
