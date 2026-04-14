/**
 * Email settings tab -- provider selection, connect/reconnect flows, custom IMAP/SMTP form.
 *
 * Lets the user pick a provider (Gmail, Outlook, Custom). For Gmail/Outlook,
 * shows a "Connect" button that initiates Unipile hosted auth. For Custom,
 * shows the full IMAP/SMTP form that POSTs to the custom email account route.
 * Displays unified account status from the emailAccount summary.
 *
 * Responsibilities:
 * - Render provider selector
 * - Gmail/Outlook: connect via Unipile hosted auth, show reconnect if needed
 * - Custom: render IMAP/SMTP forms, save via /api/user/email-accounts/custom
 * - Test connection via /api/user/settings/test-connection
 * - Show unified account status from emailAccount summary
 */

"use client";

import { useState, useEffect } from "react";
import type { UserSettings, EmailAccountSummary } from "@/lib/types";
import { useEmailStatus } from "@/contexts/EmailStatusContext";
import {
  getStoredEmailStatus,
  type EmailConnectionTestResult,
  type EmailStatus,
} from "@/lib/email-status";
import { getDashboardErrorMessage } from "@/lib/errors/dashboardErrors";
import {
  buildDashboardErrorFromResponse,
  logAndMapDashboardError,
  mapDashboardError,
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

type Provider = "gmail" | "outlook" | "custom";
type ConnectIntent = "create" | "reconnect";

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "gmail", label: "Gmail" },
  { id: "outlook", label: "Outlook" },
  { id: "custom", label: "Custom" },
];

// ============================================================================
// API HELPERS
// ============================================================================

/**
 * Fetches current user settings from the API.
 * @returns Current user settings
 */
async function fetchSettings(): Promise<UserSettings> {
  const res = await fetch("/api/user/settings");
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "EMAIL_SETTINGS_LOAD_FAILED",
      error: "Failed to load settings",
    });
  }
  return res.json();
}

/**
 * Saves a custom email account via the email-accounts API.
 * @param data - Custom email account payload
 * @returns The updated EmailAccountSummary
 */
async function saveCustomAccount(data: Record<string, unknown>): Promise<EmailAccountSummary> {
  const res = await fetch("/api/user/email-accounts/custom", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "EMAIL_SAVE_FAILED",
      error: "Failed to save email account",
    });
  }
  return res.json();
}

/**
 * Initiates a Unipile connect flow for Gmail or Outlook.
 * @param provider - "gmail" or "outlook"
 * @returns The hosted auth link URL
 */
async function initiateConnect(
  provider: string,
  intent: ConnectIntent
): Promise<string> {
  const res = await fetch("/api/user/email-accounts/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, intent }),
  });
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "EMAIL_CONNECT_FAILED",
      error: "Failed to initiate connection",
    });
  }
  const data = await res.json();
  return data.url;
}

type TestResult = EmailConnectionTestResult;

/**
 * Tests email connection using stored credentials on the server.
 * @returns Per-protocol test results
 */
async function testConnection(): Promise<TestResult> {
  const res = await fetch("/api/user/settings/test-connection", {
    method: "POST",
  });
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "EMAIL_VERIFY_FAILED",
      error: "Connection test failed",
    });
  }
  return res.json();
}

// ============================================================================
// COMPONENT
// ============================================================================

export default function EmailTab() {
  const {
    status: resolvedEmailStatus,
    message: resolvedEmailStatusMessage,
    refresh: refreshEmailStatus,
  } = useEmailStatus();

  // Provider
  const [provider, setProvider] = useState<Provider>("gmail");

  // Active email account summary from settings
  const [emailAccount, setEmailAccount] = useState<EmailAccountSummary | null>(null);

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

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [connecting, setConnecting] = useState(false);

  // Load settings on mount and refresh email status cache
  // (clears stale cache from e.g. returning after Unipile hosted auth redirect)
  useEffect(() => {
    refreshEmailStatus(true);

    async function load() {
      try {
        const settings = await fetchSettings();
        setEmailAccount(settings.emailAccount);

        if (settings.emailAccount) {
          // Set provider from existing account
          setProvider(settings.emailAccount.provider);

          if (settings.emailAccount.connectionType === "imap_smtp") {
            // Load custom fields from the account
            // NOTE: We don't have host/port details in the summary DTO,
            // so we only populate what we can. The user field serves as emailAddress.
            setImapUser(settings.emailAccount.emailAddress ?? "");
            setSmtpUser(settings.emailAccount.emailAddress ?? "");
          }
        }
      } catch (err) {
        setError(logAndMapDashboardError(err, "settings-email", "EMAIL_SETTINGS_LOAD_FAILED"));
      } finally {
        setLoading(false);
      }
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  /**
   * Switches the provider and resets UI state.
   * @param newProvider - The provider to switch to
   */
  function handleProviderChange(newProvider: Provider) {
    setProvider(newProvider);
    setError(null);
    setSaved(false);

    if (newProvider === "custom") {
      setImapHost("");
      setImapPort(993);
      setSmtpHost("");
      setSmtpPort(587);
    }
  }

  /**
   * Initiates the Unipile connect flow for Gmail/Outlook.
   * Opens the hosted auth link in a new window.
   */
  async function handleConnect(intent: ConnectIntent) {
    setConnecting(true);
    setError(null);

    try {
      const url = await initiateConnect(provider, intent);
      window.open(url, "_blank");
    } catch (err) {
      setError(logAndMapDashboardError(err, "settings-email", "EMAIL_CONNECT_FAILED"));
      setConnecting(false);
    }
  }

  /**
   * Saves the custom IMAP/SMTP account, then tests the connection.
   */
  async function handleSaveCustom() {
    setSaving(true);
    setError(null);
    setSaved(false);

    // Require passwords if none stored yet
    const hasExistingPasswords = emailAccount?.hasImapPassword && emailAccount?.hasSmtpPassword;
    if (!hasExistingPasswords && (!imapPassword || !smtpPassword)) {
      setError(getDashboardErrorMessage("EMAIL_PASSWORDS_REQUIRED"));
      setSaving(false);
      return;
    }

    try {
      // Step 1: Save custom account
      const payload: Record<string, unknown> = {
        provider: "custom",
        imapHost, imapPort, imapUser,
        smtpHost, smtpPort, smtpUser,
      };
      if (imapPassword) payload.imapPassword = imapPassword;
      if (smtpPassword) payload.smtpPassword = smtpPassword;

      const updatedAccount = await saveCustomAccount(payload);
      setEmailAccount(updatedAccount);

      // Clear password fields after save
      setImapPassword("");
      setSmtpPassword("");

      // Step 2: Test connection using stored credentials
      const result = await testConnection();
      if (!result.imap.ok || !result.smtp.ok) {
        if (!result.imap.ok && !result.smtp.ok) {
          console.error("[dashboard-error]", { context: "settings-email", error: result });
          setError(getDashboardErrorMessage("EMAIL_VERIFY_FAILED"));
        } else if (!result.imap.ok) {
          setError(result.imap.error ?? getDashboardErrorMessage("EMAIL_INBOX_VERIFY_FAILED"));
        } else {
          setError(result.smtp.error ?? getDashboardErrorMessage("EMAIL_SMTP_VERIFY_FAILED"));
        }
        refreshEmailStatus(true);
        setSaving(false);
        return;
      }

      setSaved(true);
      refreshEmailStatus(true);
    } catch (err) {
      setError(logAndMapDashboardError(err, "settings-email", "EMAIL_SAVE_FAILED"));
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

  const storedStatus = getStoredEmailStatus(emailAccount);
  const effectiveStatus = resolvedEmailStatus ?? storedStatus.status;
  const effectiveStatusMessage =
    resolvedEmailStatusMessage ?? storedStatus.message ?? null;

  // Determine if the current account is Unipile-backed and needs reconnect
  const isUnipileAccount = emailAccount?.connectionType === "unipile";
  const needsReconnect = effectiveStatus === "reconnect_required";
  const isConnected = effectiveStatus === "connected";

  return (
    <div className="">
      {/* Provider Selector */}
      <section className="settings-panel">
        <h2>Email Provider</h2>
        <p className={SETTINGS_SECTION_COPY}>
          Choose how BrewDock should connect to your inbox. Hosted providers use secure OAuth; custom lets you enter IMAP and SMTP details manually.
        </p>
        <div className={`${SETTINGS_MAX_WIDTH} flex`}>
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handleProviderChange(p.id)}
              className={`flex-1 py-2 text-[13px] font-semibold border transition-colors ${
                provider === p.id
                  ? "bg-[var(--btn-primary-bg)] text-white border-[var(--btn-primary-bg)]"
                  : "bg-[var(--bg-surface)] text-[var(--text-secondary)] border-[var(--border-color)] hover:bg-[var(--bg-hover)]"
              } ${p.id !== "gmail" ? "-ml-px" : ""}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Gmail/Outlook: Connect or Reconnect flow */}
        {provider !== "custom" && (
          <div className={`${SETTINGS_MAX_WIDTH} mt-6 text-[15px] leading-relaxed text-[var(--text-secondary)]`}>
            {/* Show current account status if connected via Unipile */}
            {isUnipileAccount && emailAccount?.provider === provider && (
              <AccountStatusBadge
                emailAddress={emailAccount.emailAddress}
                status={effectiveStatus}
                message={effectiveStatusMessage}
              />
            )}

            {/* Show error if any */}
            {error && <p className="text-red-600 text-sm font-medium mb-4">{error}</p>}

            {/* Connect / Reconnect button */}
            {needsReconnect && isUnipileAccount && emailAccount?.provider === provider ? (
              <div>
                <p className="mb-4">
                  Your {provider === "gmail" ? "Gmail" : "Outlook"} connection needs to be refreshed.
                  Click below to reconnect.
                </p>
                <button
                  type="button"
                  onClick={() => handleConnect("reconnect")}
                  disabled={connecting}
                  className="bg-amber-500 px-4 py-3 text-[15px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50 transition"
                >
                  {connecting ? "Redirecting..." : "Reconnect"}
                </button>
              </div>
            ) : isConnected && isUnipileAccount && emailAccount?.provider === provider ? (
              <p className="mt-2">
                Your {provider === "gmail" ? "Gmail" : "Outlook"} account is connected.
                To connect a different account, click below.
              </p>
            ) : (
              <p className="mb-4">
                Connect your {provider === "gmail" ? "Gmail" : "Outlook"} account securely.
                Your emails are never stored and we will never send emails on your behalf.
                You will be redirected to sign in with {provider === "gmail" ? "Google" : "Microsoft"}.
              </p>
            )}

            {/* Show connect button unless already connected with this provider */}
            {!(isConnected && isUnipileAccount && emailAccount?.provider === provider) && !needsReconnect && (
              <button
                type="button"
                onClick={() => handleConnect("create")}
                disabled={connecting}
                className="mt-4 border border-zinc-900 bg-black px-4 py-3 text-[15px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 transition"
              >
                {connecting ? "Redirecting..." : `Connect with ${provider === "gmail" ? "Gmail" : "Outlook"}`}
              </button>
            )}

            {/* Re-connect option even when already connected */}
            {isConnected && isUnipileAccount && emailAccount?.provider === provider && (
              <button
                type="button"
                onClick={() => handleConnect("create")}
                disabled={connecting}
                className="mt-4 border border-zinc-200 px-4 py-3 text-[15px] font-semibold text-black hover:bg-zinc-50 disabled:opacity-50 transition"
              >
                {connecting ? "Redirecting..." : "Connect a different account"}
              </button>
            )}

            {/* Unipile trust badge */}
            <div className="mt-4 flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
              <span>Authentication is securely handled by</span>
              <a href="https://www.unipile.com/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 bg-[var(--bg-surface)] text-[var(--text-secondary)] px-2 py-0.5 rounded-full text-xs font-medium hover:bg-[var(--bg-hover)] transition border border-[var(--border-color)]">
                <svg width="14" height="10" viewBox="0 0 79 65" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M34.2729 35.0963L20.9518 51.861C19.1738 54.09 15.7729 54.062 14.0372 51.804L1.09714 35.0399C-0.116363 33.4594 -0.116363 31.258 1.09714 29.6776L14.0372 12.9133C15.7729 10.6555 19.1738 10.6273 20.9518 12.8569L34.2729 29.6211C35.5429 31.2298 35.5429 33.5017 34.2729 35.0963Z" fill="#45BAB9"/>
                  <path d="M56.371 29.6353L43.0501 12.871C41.2721 10.6414 37.8713 10.6696 36.1356 12.9275L31.5917 18.8119L40.1997 29.6353C41.4697 31.2299 41.4697 33.5018 40.1997 35.0964L31.5917 45.92L36.1356 51.804C37.8713 54.062 41.2721 54.09 43.0501 51.861L56.371 35.0964C57.641 33.5018 57.641 31.2299 56.371 29.6353Z" fill="#43B072"/>
                  <path d="M77.637 29.6353L64.316 12.871C62.538 10.6414 59.137 10.6696 57.401 12.9275L53.45 18.0499L62.665 29.6353C63.935 31.2299 63.935 33.5018 62.665 35.0964L53.45 46.682L57.401 51.804C59.137 54.062 62.538 54.09 64.316 51.861L77.637 35.0964C78.921 33.5018 78.921 31.2299 77.637 29.6353Z" fill="#DDDF4C"/>
                </svg>
                Unipile
              </a>
            </div>
          </div>
        )}

        {/* Custom hint */}
        {provider === "custom" && (
          <p className={SETTINGS_SECTION_COPY}>
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
          {/* Show account status for existing custom accounts */}
          {emailAccount && emailAccount.provider === "custom" && (
            <section className="settings-panel">
              <div className={SETTINGS_MAX_WIDTH}>
                <AccountStatusBadge
                  emailAddress={emailAccount.emailAddress}
                  status={effectiveStatus}
                  message={effectiveStatusMessage}
                />
              </div>
            </section>
          )}

          <section className="settings-panel">
            <h2>IMAP (Incoming Mail)</h2>
            <p className={SETTINGS_SECTION_COPY}>
              Enter the server details BrewDock should use to read incoming email.
            </p>
            <div className={`${SETTINGS_MAX_WIDTH} grid grid-cols-1 gap-4 md:grid-cols-2`}>
              <InputField label="Host" value={imapHost} onChange={setImapHost} placeholder="imap.example.com" />
              <InputField label="Port" type="number" value={String(imapPort)} onChange={(v) => setImapPort(Number(v))} />
              <InputField label="Email" value={imapUser} onChange={setImapUser} placeholder="you@example.com" />
              <div>
                <InputField
                  label={emailAccount?.hasImapPassword ? "Password (leave blank to keep current)" : "Password"}
                  type="password"
                  value={imapPassword}
                  onChange={setImapPassword}
                  placeholder={emailAccount?.hasImapPassword ? "********" : "App password"}
                />
                <VaultNotice />
              </div>
            </div>
          </section>

          <section className="settings-panel">
            <h2>SMTP (Outgoing Mail)</h2>
            <p className={SETTINGS_SECTION_COPY}>
              Enter the server details BrewDock should use to draft and send email.
            </p>
            <div className={`${SETTINGS_MAX_WIDTH} grid grid-cols-1 gap-4 md:grid-cols-2`}>
              <InputField label="Host" value={smtpHost} onChange={setSmtpHost} placeholder="smtp.example.com" />
              <InputField label="Port" type="number" value={String(smtpPort)} onChange={(v) => setSmtpPort(Number(v))} />
              <InputField label="Email" value={smtpUser} onChange={setSmtpUser} placeholder="you@example.com" />
              <div>
                <InputField
                  label={emailAccount?.hasSmtpPassword ? "Password (leave blank to keep current)" : "Password"}
                  type="password"
                  value={smtpPassword}
                  onChange={setSmtpPassword}
                  placeholder={emailAccount?.hasSmtpPassword ? "********" : "App password"}
                />
                <VaultNotice />
              </div>
            </div>
          </section>
        </>
      )}

      {/* Save (Custom only) */}
      {provider === "custom" && (
        <div className={`${SETTINGS_MAX_WIDTH} flex flex-col items-start gap-3`}>
          <button
            type="button"
            onClick={handleSaveCustom}
            disabled={saving}
            className="border border-zinc-900 bg-black px-6 py-3 text-[15px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
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

/**
 * Displays the current account connection status as a compact badge.
 * @param emailAddress - The account email address
 * @param status - The effective email status
 * @param message - Optional connection detail
 */
function AccountStatusBadge({
  emailAddress,
  status,
  message,
}: {
  emailAddress: EmailAccountSummary["emailAddress"];
  status: EmailStatus;
  message: string | null;
}) {
  const statusConfig: Record<string, { dot: string; text: string; label: string }> = {
    connected: { dot: "bg-green-600", text: "text-green-700", label: "Connected" },
    reconnect_required: { dot: "bg-amber-500", text: "text-amber-700", label: "Reconnect required" },
    pending: { dot: "bg-blue-500", text: "text-blue-700", label: "Pending" },
    not_configured: { dot: "bg-slate-400", text: "text-slate-700", label: "Not configured" },
    error: { dot: "bg-red-500", text: "text-red-700", label: "Error" },
  };

  const config = statusConfig[status] ?? statusConfig.error;

  return (
    <div className={`${SETTINGS_FIELD_CARD} flex flex-col gap-3`}>
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${config.dot}`} />
        <span className={`text-[14px] font-semibold ${config.text}`}>{config.label}</span>
      </div>
      {emailAddress && (
        <span className="text-[15px] text-[var(--text-secondary)]">
          {emailAddress}
        </span>
      )}
      {message && (
        <span className="text-[12px] text-red-600">
          {mapDashboardError(
            message,
            "email",
            status === "reconnect_required"
              ? "EMAIL_RECONNECT_REQUIRED"
              : "EMAIL_INBOX_CONNECT_FAILED"
          )}
        </span>
      )}
    </div>
  );
}

function VaultNotice() {
  return (
    <div className={`mt-1 flex items-center gap-1.5 text-xs text-[var(--text-secondary)]`}>
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

interface InputFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}

function InputField({ label, value, onChange, placeholder, type = "text" }: InputFieldProps) {
  return (
    <div className={SETTINGS_FIELD_CARD}>
      <label className={SETTINGS_FIELD_LABEL}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={SETTINGS_INPUT}
      />
    </div>
  );
}
