/**
 * Email settings tab -- provider selection, IMAP/SMTP configuration.
 *
 * Lets the user pick a provider (Gmail, Outlook, Custom) which pre-fills
 * known host/port values and shows provider-specific setup instructions.
 * A single Save button tests the connection before persisting.
 *
 * Responsibilities:
 * - Render provider selector with setup instructions
 * - Render IMAP and SMTP configuration forms
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
 * Tests IMAP and SMTP connections with the provided credentials.
 * @param data - Connection parameters to test
 * @returns Per-protocol test results
 */
async function testConnection(data: Record<string, unknown>): Promise<TestResult> {
  const res = await fetch("/api/user/settings/test-connection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
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

  // IMAP state
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(993);
  const [imapUser, setImapUser] = useState("");
  const [imapPassword, setImapPassword] = useState("");
  const [hasImapPassword, setHasImapPassword] = useState(false);

  // SMTP state
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [hasSmtpPassword, setHasSmtpPassword] = useState(false);

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
        setImapHost(settings.imapHost);
        setImapPort(settings.imapPort);
        setImapUser(settings.imapUser);
        setHasImapPassword(settings.hasImapPassword);
        setSmtpHost(settings.smtpHost);
        setSmtpPort(settings.smtpPort);
        setSmtpUser(settings.smtpUser);
        setHasSmtpPassword(settings.hasSmtpPassword);
        setProvider(detectProvider(settings.imapHost));
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
   * Applies a provider preset, filling in known host/port values.
   * Keeps user/password fields untouched.
   * @param newProvider - The provider to switch to
   */
  function handleProviderChange(newProvider: Provider) {
    setProvider(newProvider);
    setError(null);
    setSaved(false);
    const preset = PROVIDER_PRESETS[newProvider];
    setImapHost(preset.imapHost);
    setImapPort(preset.imapPort);
    setSmtpHost(preset.smtpHost);
    setSmtpPort(preset.smtpPort);

    // For Gmail and Outlook, SMTP user is the same as IMAP user
    if (newProvider !== "custom") {
      setSmtpUser(imapUser);
    }
  }

  /**
   * Tests the connection, then saves if successful.
   * Shows specific errors for IMAP/SMTP failures.
   */
  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);

    // Require passwords for a connection test
    const needsImapPassword = !hasImapPassword && !imapPassword;
    const needsSmtpPassword = !hasSmtpPassword && !smtpPassword;
    if (needsImapPassword || needsSmtpPassword) {
      setError("Please enter passwords for both IMAP and SMTP.");
      setSaving(false);
      return;
    }

    try {
      // Step 1: Test connection (only if new passwords were provided)
      if (imapPassword && smtpPassword) {
        const result = await testConnection({
          imapHost, imapPort, imapUser, imapPassword,
          smtpHost, smtpPort, smtpUser, smtpPassword,
        });

        const errors: string[] = [];
        if (!result.imap.ok) errors.push(`IMAP: ${result.imap.error}`);
        if (!result.smtp.ok) errors.push(`SMTP: ${result.smtp.error}`);
        if (errors.length > 0) {
          setError(errors.join(" | "));
          setSaving(false);
          return;
        }
      }

      // Step 2: Save settings
      const payload: Record<string, unknown> = {
        imapHost, imapPort, imapUser,
        smtpHost, smtpPort, smtpUser,
      };
      if (imapPassword) payload.imapPassword = imapPassword;
      if (smtpPassword) payload.smtpPassword = smtpPassword;

      await saveSettings(payload);

      if (imapPassword) setHasImapPassword(true);
      if (smtpPassword) setHasSmtpPassword(true);
      setImapPassword("");
      setSmtpPassword("");
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
    return <p className="text-gray-500">Loading...</p>;
  }

  return (
    <div className="space-y-8">
      {/* Provider Selector */}
      <section className="border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-black">Email Provider</h2>
        <div className="flex gap-0">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handleProviderChange(p.id)}
              className={`px-5 py-2 text-sm font-medium border transition-colors ${
                provider === p.id
                  ? "bg-black text-white border-black"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
              } ${p.id === "gmail" ? "rounded-l" : ""} ${p.id === "custom" ? "rounded-r" : ""} ${p.id !== "gmail" ? "-ml-px" : ""}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Provider-specific instructions */}
        {provider === "gmail" && <ProviderInstructions provider="gmail" />}
        {provider === "outlook" && <ProviderInstructions provider="outlook" />}
        {provider === "custom" && (
          <p className="mt-4 text-sm text-gray-500">
            Enter your IMAP and SMTP server details below.
          </p>
        )}
      </section>

      {/* Error banner */}
      {error && (
        <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* IMAP Configuration */}
      <section className="border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-black">IMAP (Incoming Mail)</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <InputField
            label="Host"
            value={imapHost}
            onChange={setImapHost}
            placeholder="imap.example.com"
            disabled={provider !== "custom"}
          />
          <InputField
            label="Port"
            type="number"
            value={String(imapPort)}
            onChange={(v) => setImapPort(Number(v))}
            disabled={provider !== "custom"}
          />
          <InputField
            label="Email"
            value={imapUser}
            onChange={(v) => {
              setImapUser(v);
              // Sync SMTP user for known providers
              if (provider !== "custom") setSmtpUser(v);
            }}
            placeholder="you@example.com"
          />
          <InputField
            label={hasImapPassword
              ? `${provider === "gmail" ? "App Password" : "Password"} (leave blank to keep current)`
              : provider === "gmail" ? "App Password" : "Password"}
            type="password"
            value={imapPassword}
            onChange={setImapPassword}
            placeholder={hasImapPassword ? "********" : provider === "gmail" ? "16-character app password" : "App password"}
          />
          <VaultNotice />
        </div>
      </section>

      {/* SMTP Configuration */}
      <section className="border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-black">SMTP (Outgoing Mail)</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <InputField
            label="Host"
            value={smtpHost}
            onChange={setSmtpHost}
            placeholder="smtp.example.com"
            disabled={provider !== "custom"}
          />
          <InputField
            label="Port"
            type="number"
            value={String(smtpPort)}
            onChange={(v) => setSmtpPort(Number(v))}
            disabled={provider !== "custom"}
          />
          <InputField
            label="Email"
            value={smtpUser}
            onChange={setSmtpUser}
            placeholder="you@example.com"
          />
          <InputField
            label={hasSmtpPassword
              ? `${provider === "gmail" ? "App Password" : "Password"} (leave blank to keep current)`
              : provider === "gmail" ? "App Password" : "Password"}
            type="password"
            value={smtpPassword}
            onChange={setSmtpPassword}
            placeholder={hasSmtpPassword ? "********" : provider === "gmail" ? "16-character app password" : "App password"}
          />
          <VaultNotice />
        </div>
      </section>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="bg-black px-6 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {saving ? "Testing connection..." : "Test & Save"}
        </button>
        {saved && (
          <span className="bg-green-100 px-3 py-1 text-sm font-medium text-green-700">
            Connection verified and saved
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

/**
 * Renders provider-specific setup instructions.
 * @param provider - "gmail" or "outlook"
 */
function ProviderInstructions({ provider }: { provider: "gmail" | "outlook" }) {
  if (provider === "gmail") {
    return (
      <div className="mt-4 space-y-2 text-sm text-gray-600">
        <p className="font-medium text-gray-800">Setup instructions for Gmail:</p>
        <ol className="list-decimal list-inside space-y-1">
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
          </li>
          <li>Create a new app password (select &quot;Mail&quot; or type a custom name)</li>
          <li>Copy the 16-character password and paste it below</li>
        </ol>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-2 text-sm text-gray-600">
      <p className="font-medium text-gray-800">Setup instructions for Outlook / Microsoft 365:</p>
      <ol className="list-decimal list-inside space-y-1">
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
        </li>
        <li>Copy the generated password and paste it below</li>
      </ol>
      <p className="mt-1 text-xs text-gray-400">
        For work/school accounts, your admin may need to enable IMAP access.
      </p>
    </div>
  );
}

function VaultNotice() {
  return (
    <div className="flex items-center gap-1.5 text-xs text-gray-400 mt-1">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3 shrink-0">
        <path fillRule="evenodd" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z" clipRule="evenodd" />
      </svg>
      <span>
        Encrypted using{" "}
        <a href="https://supabase.com/" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-600">
          Supabase Vault
        </a>
      </span>
    </div>
  );
}

interface InputFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}

function InputField({ label, value, onChange, placeholder, type = "text", disabled = false }: InputFieldProps) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none focus:ring-1 focus:ring-black disabled:bg-gray-100 disabled:text-gray-500"
      />
    </div>
  );
}
