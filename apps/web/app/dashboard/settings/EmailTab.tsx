/**
 * Email settings tab -- provider selection, IMAP/SMTP configuration.
 *
 * Lets the user pick a provider (Gmail, Outlook, Custom). For Gmail/Outlook,
 * input fields are embedded inline in the setup instructions. For Custom,
 * full IMAP and SMTP sections are shown.
 * A single Save button tests the connection before persisting.
 *
 * Responsibilities:
 * - Render provider selector with inline setup instructions
 * - Render full IMAP/SMTP forms for Custom provider
 * - Test connection before saving via /api/user/settings/test-connection
 * - Save email settings via /api/user/settings
 */

"use client";

import { useState, useEffect } from "react";
import type { UserSettings } from "@/lib/types";

// ============================================================================
// CONSTANTS
// ============================================================================

type Provider = "gmail" | "outlook" | "custom";

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "gmail", label: "Gmail" },
  { id: "outlook", label: "Outlook" },
  { id: "custom", label: "Custom" },
];

const PROVIDER_PRESETS: Record<Provider, { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }> = {
  gmail: { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 587 },
  outlook: { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp.office365.com", smtpPort: 587 },
  custom: { imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 587 },
};

// ============================================================================
// API HELPERS
// ============================================================================

/**
 * Fetches current user settings from the API.
 * @returns Current user settings
 */
async function fetchSettings(): Promise<UserSettings> {
  const res = await fetch("/api/user/settings");
  if (!res.ok) throw new Error("Failed to load settings");
  return res.json();
}

/**
 * Saves settings to the API.
 * @param data - Settings payload to save
 * @returns Updated user settings
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

interface TestResult {
  imap: { ok: boolean; error?: string };
  smtp: { ok: boolean; error?: string };
}

/**
 * Tests IMAP and SMTP connections using stored credentials on the server.
 * @returns Per-protocol test results
 */
async function testConnection(): Promise<TestResult> {
  const res = await fetch("/api/user/settings/test-connection", {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error || "Connection test failed");
  }
  return res.json();
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Detects the provider based on the IMAP host.
 * @param imapHost - The IMAP host to check
 * @returns Detected provider
 */
function detectProvider(imapHost: string): Provider {
  if (imapHost === "imap.gmail.com") return "gmail";
  if (imapHost === "outlook.office365.com") return "outlook";
  return "custom";
}

// ============================================================================
// COMPONENT
// ============================================================================

export default function EmailTab() {
  // Provider
  const [provider, setProvider] = useState<Provider>("gmail");

  // Shared fields for Gmail/Outlook (single email + password)
  const [email, setEmail] = useState("");
  const [appPassword, setAppPassword] = useState("");

  // IMAP state (Custom only)
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(993);
  const [imapUser, setImapUser] = useState("");
  const [imapPassword, setImapPassword] = useState("");

  // SMTP state (Custom only)
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");

  // Tracks whether passwords already exist on the server
  const [hasPassword, setHasPassword] = useState(false);

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Load settings on mount
  useEffect(() => {
    async function load() {
      try {
        const settings = await fetchSettings();
        const detected = detectProvider(settings.imapHost);
        setProvider(detected);

        if (detected !== "custom") {
          // Gmail/Outlook: single email + password
          setEmail(settings.imapUser);
          setHasPassword(settings.hasImapPassword);
        } else {
          // Custom: separate IMAP/SMTP fields
          setImapHost(settings.imapHost);
          setImapPort(settings.imapPort);
          setImapUser(settings.imapUser);
          setSmtpHost(settings.smtpHost);
          setSmtpPort(settings.smtpPort);
          setSmtpUser(settings.smtpUser);
          setHasPassword(settings.hasImapPassword && settings.hasSmtpPassword);
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
   * Switches the provider, resets fields, and applies presets.
   * @param newProvider - The provider to switch to
   */
  function handleProviderChange(newProvider: Provider) {
    setProvider(newProvider);
    setError(null);
    setSaved(false);

    if (newProvider !== "custom") {
      const preset = PROVIDER_PRESETS[newProvider];
      setImapHost(preset.imapHost);
      setImapPort(preset.imapPort);
      setSmtpHost(preset.smtpHost);
      setSmtpPort(preset.smtpPort);
    } else {
      setImapHost("");
      setImapPort(993);
      setSmtpHost("");
      setSmtpPort(587);
    }
  }

  /**
   * Tests the connection, then saves if successful.
   * For Gmail/Outlook, uses the shared email + appPassword for both protocols.
   * For Custom, uses separate IMAP/SMTP fields.
   */
  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);

    // Build the connection params based on provider
    let imapH: string, imapP: number, imapU: string, imapPw: string;
    let smtpH: string, smtpP: number, smtpU: string, smtpPw: string;

    if (provider !== "custom") {
      const preset = PROVIDER_PRESETS[provider];
      imapH = preset.imapHost;
      imapP = preset.imapPort;
      imapU = email;
      imapPw = appPassword;
      smtpH = preset.smtpHost;
      smtpP = preset.smtpPort;
      smtpU = email;
      smtpPw = appPassword;
    } else {
      imapH = imapHost;
      imapP = imapPort;
      imapU = imapUser;
      imapPw = imapPassword;
      smtpH = smtpHost;
      smtpP = smtpPort;
      smtpU = smtpUser;
      smtpPw = smtpPassword;
    }

    // Require passwords
    const needsPassword = !hasPassword && !imapPw;
    const needsSmtpPassword = !hasPassword && !smtpPw;
    if (needsPassword || needsSmtpPassword) {
      setError(provider !== "custom"
        ? "Please enter your app password."
        : "Please enter passwords for both IMAP and SMTP.");
      setSaving(false);
      return;
    }

    try {
      // Step 1: Save settings
      const payload: Record<string, unknown> = {
        imapHost: imapH, imapPort: imapP, imapUser: imapU,
        smtpHost: smtpH, smtpPort: smtpP, smtpUser: smtpU,
      };
      if (imapPw) payload.imapPassword = imapPw;
      if (smtpPw) payload.smtpPassword = smtpPw;

      await saveSettings(payload);

      setHasPassword(true);
      if (provider !== "custom") {
        setAppPassword("");
      } else {
        setImapPassword("");
        setSmtpPassword("");
      }

      // Step 2: Test connection using stored credentials
      const result = await testConnection();
      if (!result.imap.ok || !result.smtp.ok) {
        const parts: string[] = [];
        if (!result.imap.ok) parts.push("receiving emails");
        if (!result.smtp.ok) parts.push("sending emails");
        setError(
          `Your settings were saved, but we could not connect for ${parts.join(" and ")}. `
          + "Please double-check your email address and app password."
        );
        setSaving(false);
        return;
      }

      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  if (loading) {
    return <p className="text-[var(--text-secondary)]">Loading...</p>;
  }

  return (
    <div className="space-y-8">
      {/* Provider Selector */}
      <section className="border border-gray-200 bg-white p-6">
        <h2 >Email Provider</h2>
        <div className="flex gap-0">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handleProviderChange(p.id)}
              className={`px-5 py-2 text-[13px] font-medium border transition-colors ${
                provider === p.id
                  ? "bg-black text-white border-black"
                  : "bg-white text-[var(--text-secondary)] border-gray-300 hover:bg-gray-50"
              } ${p.id === "gmail" ? "rounded-l" : ""} ${p.id === "custom" ? "rounded-r" : ""} ${p.id !== "gmail" ? "-ml-px" : ""}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Gmail inline instructions */}
        {provider === "gmail" && (
          <GmailInstructions
            email={email}
            onEmailChange={setEmail}
            appPassword={appPassword}
            onAppPasswordChange={setAppPassword}
            hasPassword={hasPassword}
            saving={saving}
            saved={saved}
            error={error}
            onSave={handleSave}
          />
        )}

        {/* Outlook inline instructions */}
        {provider === "outlook" && (
          <OutlookInstructions
            email={email}
            onEmailChange={setEmail}
            appPassword={appPassword}
            onAppPasswordChange={setAppPassword}
            hasPassword={hasPassword}
            saving={saving}
            saved={saved}
            error={error}
            onSave={handleSave}
          />
        )}

        {/* Custom hint */}
        {provider === "custom" && (
          <p className="mt-4 text-[13px] text-[var(--text-secondary)]">
            Enter your IMAP and SMTP server details below.
          </p>
        )}
      </section>

      {/* Custom: error banner + full IMAP/SMTP sections */}
      {provider === "custom" && error && (
        <div className="border border-red-200 bg-red-50 p-4 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {provider === "custom" && (
        <>
          <section className="border border-gray-200 bg-white p-6">
            <h2 >IMAP (Incoming Mail)</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <InputField label="Host" value={imapHost} onChange={setImapHost} placeholder="imap.example.com" />
              <InputField label="Port" type="number" value={String(imapPort)} onChange={(v) => setImapPort(Number(v))} />
              <InputField label="Email" value={imapUser} onChange={setImapUser} placeholder="you@example.com" />
              <div>
                <InputField
                  label={hasPassword ? "Password (leave blank to keep current)" : "Password"}
                  type="password"
                  value={imapPassword}
                  onChange={setImapPassword}
                  placeholder={hasPassword ? "********" : "App password"}
                />
                <VaultNotice />
              </div>
            </div>
          </section>

          <section className="border border-gray-200 bg-white p-6">
            <h2 >SMTP (Outgoing Mail)</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <InputField label="Host" value={smtpHost} onChange={setSmtpHost} placeholder="smtp.example.com" />
              <InputField label="Port" type="number" value={String(smtpPort)} onChange={(v) => setSmtpPort(Number(v))} />
              <InputField label="Email" value={smtpUser} onChange={setSmtpUser} placeholder="you@example.com" />
              <div>
                <InputField
                  label={hasPassword ? "Password (leave blank to keep current)" : "Password"}
                  type="password"
                  value={smtpPassword}
                  onChange={setSmtpPassword}
                  placeholder={hasPassword ? "********" : "App password"}
                />
                <VaultNotice />
              </div>
            </div>
          </section>
        </>
      )}

      {/* Save (Custom only -- Gmail/Outlook have it inline) */}
      {provider === "custom" && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="bg-black px-6 py-2 text-[13px] font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {saving ? "Testing connection..." : "Test & Save"}
          </button>
          {saved && (
            <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">
              Connection verified and saved
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

interface ProviderInstructionsProps {
  email: string;
  onEmailChange: (value: string) => void;
  appPassword: string;
  onAppPasswordChange: (value: string) => void;
  hasPassword: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
  onSave: () => void;
}

/**
 * Gmail setup instructions with inline email and app password fields.
 */
function GmailInstructions({ email, onEmailChange, appPassword, onAppPasswordChange, hasPassword, saving, saved, error, onSave }: ProviderInstructionsProps) {
  return (
    <div className="mt-4 text-[13px] text-[var(--text-secondary)]">
      <ol className="list-decimal list-inside space-y-4">
        <li>
          Enter your Gmail address
          <div className="mt-1.5 ml-5">
            <InlineInput
              value={email}
              onChange={onEmailChange}
              placeholder="you@gmail.com"
            />
          </div>
        </li>
        <li>
          Make sure{" "}
          <a
            href="https://myaccount.google.com/signinoptions/two-step-verification"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 underline"
          >
            2-Step Verification
          </a>
          {" "}is enabled on your Google Account
        </li>
        <li>
          Go to{" "}
          <a
            href="https://myaccount.google.com/apppasswords"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 underline"
          >
            App passwords
          </a>
          {" "}and create a new one (type a name, e.g. &quot;Mail&quot;)
        </li>
        <li>
          {hasPassword ? "Paste your new app password (leave blank to keep current)" : "Paste your app password"}
          <div className="mt-1.5 ml-5">
            <InlineInput
              value={appPassword}
              onChange={onAppPasswordChange}
              placeholder={hasPassword ? "********" : "16-character app password"}
              type="password"
            />
            <VaultNotice />
          </div>
        </li>
      </ol>

      {error && (
        <div className="mt-4 border border-red-200 bg-red-50 p-3 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="bg-black px-6 py-2 text-[13px] font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {saving ? "Testing connection..." : "Test & Save"}
        </button>
        {saved && (
          <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">
            Connection verified and saved
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Outlook setup instructions with inline email and app password fields.
 */
function OutlookInstructions({ email, onEmailChange, appPassword, onAppPasswordChange, hasPassword, saving, saved, error, onSave }: ProviderInstructionsProps) {
  return (
    <div className="mt-4 text-[13px] text-[var(--text-secondary)]">
      <ol className="list-decimal list-inside space-y-4">
        <li>
          Enter your Outlook email address
          <div className="mt-1.5 ml-5">
            <InlineInput
              value={email}
              onChange={onEmailChange}
              placeholder="you@outlook.com"
            />
          </div>
        </li>
        <li>
          Sign in to your{" "}
          <a
            href="https://account.microsoft.com/security"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 underline"
          >
            Microsoft account security page
          </a>
        </li>
        <li>
          Enable{" "}
          <a
            href="https://aka.ms/MFASetup"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 underline"
          >
            two-step verification
          </a>
          {" "}if not already active
        </li>
        <li>
          Go to{" "}
          <a
            href="https://account.live.com/proofs/AppPassword"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 underline"
          >
            App passwords
          </a>
          {" "}and create a new one
          <p className="mt-2 ml-5 text-xs ">
            For work/school accounts, your admin may need to enable IMAP access.
          </p>
        </li>
        <li>
          {hasPassword ? "Paste your new app password (leave blank to keep current)" : "Paste your app password"}
          <div className="mt-1.5 ml-5">
            <InlineInput
              value={appPassword}
              onChange={onAppPasswordChange}
              placeholder={hasPassword ? "********" : "App password"}
              type="password"
            />
            <VaultNotice />
          </div>
        </li>
      </ol>

      {error && (
        <div className="mt-4 border border-red-200 bg-red-50 p-3 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="bg-black px-6 py-2 text-[13px] font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {saving ? "Testing connection..." : "Test & Save"}
        </button>
        {saved && (
          <span className="bg-green-100 px-3 py-1 text-[13px] font-medium text-green-700">
            Connection verified and saved
          </span>
        )}
      </div>
    </div>
  );
}

function VaultNotice() {
  return (
    <div className="flex items-center gap-1.5 text-xs  mt-1">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3 shrink-0">
        <path fillRule="evenodd" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z" clipRule="evenodd" />
      </svg>
      <span>
        Encrypted using{" "}
        <a href="https://supabase.com/" target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--text-secondary)]">
          Supabase Vault
        </a>
. Your emails are never stored on our servers.
      </span>
    </div>
  );
}

interface InlineInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}

function InlineInput({ value, onChange, placeholder, type = "text" }: InlineInputProps) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full max-w-sm border border-gray-300 px-3 py-1.5 text-[13px] focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
    />
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
        className="w-full border border-gray-300 px-3 py-2 text-[13px] focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
      />
    </div>
  );
}
