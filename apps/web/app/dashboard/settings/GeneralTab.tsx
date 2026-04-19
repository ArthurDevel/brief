/**
 * General settings tab -- phone, PIN, and action approvals.
 *
 * - Text input sections (phone, PIN): show a Save button when there are pending changes
 * - Action approval selectors auto-save on change
 */

"use client";

import { useState, useEffect } from "react";
import {
  parsePhoneNumber,
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  type CountryCode,
} from "libphonenumber-js";
import examples from "libphonenumber-js/examples.mobile.json";
import type { UserSettings, CompanyPhone } from "@/lib/types";
import type { ToolApprovalConfig, ActionClassification } from "@dublin/tools/src/types";
import { TOOL_LABELS } from "@dublin/tools/src/definitions";
import { getDefaultClassification } from "@dublin/tools/src/classification";
import { getDashboardErrorMessage } from "@/lib/errors/dashboardErrors";
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

interface CountryOption {
  code: CountryCode;
  label: string;
  callingCode: string;
}

const COUNTRY_OPTIONS: CountryOption[] = (() => {
  const displayNames = new Intl.DisplayNames(["en"], { type: "region" });

  return getCountries()
    .map((code) => ({
      code,
      label: displayNames.of(code) ?? code,
      callingCode: `+${getCountryCallingCode(code)}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
})();

interface PhoneFormState {
  localNumber: string;
  countryCode: CountryCode | "";
}

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

async function savePhone(phone: PhoneFormState): Promise<void> {
  const res = await fetch("/api/user/phone", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      number: buildFullPhoneNumber(phone.localNumber, phone.countryCode),
      countryCode: phone.countryCode,
    }),
  });
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "PHONE_SAVE_FAILED",
      error: "Failed to save phone number",
    });
  }
}

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

async function fetchCompanyPhones(): Promise<CompanyPhone[]> {
  const res = await fetch("/api/company-phones");
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "COMPANY_PHONES_LOAD_FAILED",
      error: "Failed to load company phone numbers",
    });
  }
  return res.json();
}

function isAlwaysApprovalTool(toolName: string): boolean {
  return toolName === "send_email" || toolName === "reply_email";
}

function getClassificationSummaryLabel(classification: ActionClassification): string {
  return CLASSIFICATION_LABELS[classification];
}

function getSelectableClassificationValue(
  classification: ActionClassification | undefined
): "" | Exclude<ActionClassification, "read_only"> {
  if (!classification) {
    return "";
  }

  return classification === "mutating_queued" ? "mutating_queued" : "mutating_auto";
}

function isCountryCode(value: string): value is CountryCode {
  return COUNTRY_OPTIONS.some((country) => country.code === value);
}

function getSelectedCountry(countryCode: CountryCode | ""): CountryOption | null {
  if (!countryCode) {
    return null;
  }

  return COUNTRY_OPTIONS.find((country) => country.code === countryCode) ?? null;
}

function buildFullPhoneNumber(localNumber: string, countryCode: CountryCode | ""): string {
  const selectedCountry = getSelectedCountry(countryCode);
  if (!selectedCountry) {
    return localNumber;
  }

  const digits = localNumber.replace(/\s/g, "").replace(/^0+/, "");
  return `${selectedCountry.callingCode}${digits}`;
}

function toPhoneFormState(settingsPhone: UserSettings["phone"]): PhoneFormState {
  if (!settingsPhone?.number) {
    return { localNumber: "", countryCode: "" };
  }

  const resolvedCountryCode = isCountryCode(settingsPhone.countryCode) ? settingsPhone.countryCode : "";

  try {
    const parsed = parsePhoneNumber(settingsPhone.number);
    const parsedCountryCode = parsed?.country && isCountryCode(parsed.country) ? parsed.country : resolvedCountryCode;

    return {
      localNumber: parsed?.formatNational() ?? settingsPhone.number,
      countryCode: parsedCountryCode,
    };
  } catch {
    return {
      localNumber: settingsPhone.number,
      countryCode: resolvedCountryCode,
    };
  }
}

export default function GeneralTab() {
  const [phone, setPhone] = useState<PhoneFormState>({ localNumber: "", countryCode: "" });
  const [savedPhone, setSavedPhone] = useState<PhoneFormState>({ localNumber: "", countryCode: "" });
  const [whatsappPhone, setWhatsappPhone] = useState<string | null>(null);
  const [whatsappPhoneDraft, setWhatsappPhoneDraft] = useState("");
  const [pin, setPin] = useState("");
  const [hasPin, setHasPin] = useState(false);
  const [toolApprovalConfig, setToolApprovalConfig] = useState<ToolApprovalConfig>({});
  const [companyPhones, setCompanyPhones] = useState<CompanyPhone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedSection, setSavedSection] = useState<string | null>(null);
  const [savingSection, setSavingSection] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [settings, phones] = await Promise.all([fetchSettings(), fetchCompanyPhones()]);
        const loadedPhone = toPhoneFormState(settings.phone);

        setPhone(loadedPhone);
        setSavedPhone(loadedPhone);
        setWhatsappPhone(settings.whatsappPhone);
        setWhatsappPhoneDraft(settings.whatsappPhone ?? "");
        setHasPin(settings.hasPin);
        setToolApprovalConfig(settings.toolApprovalConfig);
        setCompanyPhones(phones);
      } catch (err) {
        setError(logAndMapDashboardError(err, "settings-general", "SETTINGS_LOAD_FAILED"));
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  const phoneDirty =
    phone.localNumber !== savedPhone.localNumber || phone.countryCode !== savedPhone.countryCode;
  const phoneUnsupported =
    phone.countryCode !== "" &&
    !companyPhones.some((companyPhone) => companyPhone.countryCode === phone.countryCode);
  const whatsappPhoneDirty = whatsappPhoneDraft !== (whatsappPhone ?? "");
  const pinDirty = pin !== "";
  const selectedCountry = getSelectedCountry(phone.countryCode);
  const exampleNumber =
    phone.countryCode && isCountryCode(phone.countryCode)
      ? getExampleNumber(phone.countryCode, examples)?.formatNational() ?? ""
      : "";

  function flashSaved(section: string) {
    setSavedSection(section);
    window.setTimeout(() => {
      setSavedSection((current) => (current === section ? null : current));
    }, 1500);
  }

  function handlePhoneNumberChange(value: string): void {
    setPhone((prev) => ({ ...prev, localNumber: value }));
  }

  function handleCountryChange(countryCode: string): void {
    setPhone((prev) => ({
      ...prev,
      countryCode: isCountryCode(countryCode) ? countryCode : "",
    }));
  }

  function handlePinChange(value: string): void {
    setPin(value.replace(/\D/g, "").slice(0, 6));
  }

  async function handleSavePhone(): Promise<void> {
    setSavingSection("phone");
    setError(null);

    try {
      if (!phone.countryCode) {
        setError("Please select your country.");
        setSavingSection(null);
        return;
      }

      const digits = phone.localNumber.replace(/\s/g, "");
      if (!digits || digits.replace(/^0+/, "").length < 4) {
        setError("Please enter your phone number.");
        setSavingSection(null);
        return;
      }

      const parsed = parsePhoneNumber(buildFullPhoneNumber(phone.localNumber, phone.countryCode));
      if (parsed?.country && parsed.country !== phone.countryCode) {
        setError(getDashboardErrorMessage("PHONE_COUNTRY_MISMATCH"));
        setSavingSection(null);
        return;
      }
    } catch {
      setError(getDashboardErrorMessage("PHONE_INVALID"));
      setSavingSection(null);
      return;
    }

    try {
      await savePhone(phone);
      setSavedPhone(phone);
      flashSaved("phone");
    } catch (err) {
      setError(logAndMapDashboardError(err, "settings-general", "PHONE_SAVE_FAILED"));
    } finally {
      setSavingSection(null);
    }
  }

  async function handleSavePin() {
    setSavingSection("pin");
    setError(null);

    try {
      await saveSettings({ pin });
      setHasPin(true);
      setPin("");
      flashSaved("pin");
    } catch (err) {
      setError(logAndMapDashboardError(err, "settings-general", "PIN_SAVE_FAILED"));
    } finally {
      setSavingSection(null);
    }
  }

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

  async function handleToolApprovalChange(toolName: string, classification: ActionClassification) {
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
          <h2>Phone Number</h2>
          <p className={SETTINGS_SECTION_COPY}>
            We use this to verify your caller ID when you call in. We will never share it or send spam.
          </p>
          <div className={SETTINGS_MAX_WIDTH}>
            <div className="mb-4">
              <label className={SETTINGS_FIELD_LABEL}>Country</label>
              <select
                value={phone.countryCode}
                onChange={(e) => handleCountryChange(e.target.value)}
                className={SETTINGS_INPUT}
              >
                <option value="">Select a country</option>
                {COUNTRY_OPTIONS.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.label} ({country.callingCode})
                  </option>
                ))}
              </select>
            </div>

            <div className="mb-2">
              <label className={SETTINGS_FIELD_LABEL}>Phone number</label>
              <div className="flex min-w-0">
                <span className="inline-flex items-center border border-r-0 border-zinc-300 bg-zinc-100 px-3 text-[15px] font-semibold text-zinc-600 select-none">
                  {selectedCountry?.callingCode ?? "+"}
                </span>
                <input
                  type="tel"
                  value={phone.localNumber}
                  onChange={(e) => handlePhoneNumberChange(e.target.value)}
                  className="min-w-0 flex-1 border border-zinc-300 bg-white px-3 py-2 text-lg font-medium tracking-wide placeholder-zinc-300 transition focus:border-black focus:outline-none"
                  placeholder={exampleNumber || "555 123 4567"}
                />
              </div>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            {phoneDirty ? (
              <SectionSaveButton onClick={handleSavePhone} saving={savingSection === "phone"} />
            ) : savedSection === "phone" ? (
              <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">
                Saved
              </span>
            ) : null}
          </div>
          {phoneUnsupported && (
            <p className="mt-3 text-sm text-red-600">
              Phone calls are not yet available in your country. Supported countries:{" "}
              {companyPhones.map((companyPhone) => companyPhone.label).join(", ")}.
            </p>
          )}
        </section>

        <section className="settings-panel">
          <h2>WhatsApp Login</h2>
          <p className={SETTINGS_SECTION_COPY}>
            This number is used only for the standalone <code>/whatsapp</code> login flow. It does not replace your
            caller-ID phone setting above.
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
              Existing users can link a number here. If someone starts from WhatsApp with an unknown number, the login
              flow can also create a new Supabase account automatically using an internal auth email behind the scenes.
            </p>
          </div>
          <div className="mt-4 flex justify-end">
            {whatsappPhoneDirty ? (
              <SectionSaveButton onClick={handleSaveWhatsAppPhone} saving={savingSection === "whatsapp"} />
            ) : savedSection === "whatsapp" ? (
              <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">
                Saved
              </span>
            ) : null}
          </div>
        </section>

        <section className="settings-panel">
          <h2>PIN</h2>
          <p className={SETTINGS_SECTION_COPY}>
            You enter this PIN when you call in to verify your identity. Choose 4 to 6 digits.
          </p>
          <div className={SETTINGS_MAX_WIDTH}>
            <label className={SETTINGS_FIELD_LABEL}>PIN (4-6 digits)</label>
            <input
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => handlePinChange(e.target.value)}
              placeholder={hasPin ? "----" : "----"}
              className="w-full border border-zinc-300 bg-white px-3 py-2 text-center text-lg font-medium tracking-[0.3em] placeholder-zinc-300 transition focus:border-black focus:outline-none"
            />
          </div>
          <div className="mt-4 flex justify-end">
            {pinDirty ? (
              <SectionSaveButton onClick={handleSavePin} saving={savingSection === "pin"} />
            ) : savedSection === "pin" ? (
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
              <div
                key={toolName}
                className={SETTINGS_FIELD_CARD}
              >
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
                      handleToolApprovalChange(toolName, e.target.value as ActionClassification)
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
