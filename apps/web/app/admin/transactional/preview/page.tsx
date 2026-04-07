/**
 * Email template preview page.
 *
 * Renders engagement email templates in an iframe so admins
 * can see exactly what users receive.
 *
 * Responsibilities:
 * - Dropdown to select email type
 * - Render the selected template HTML in an iframe
 */

"use client";

import { useState, useEffect } from "react";
import { previewEmailHtml } from "../actions";
import type { EmailType } from "@/lib/engagement/types";

// ============================================================================
// CONSTANTS
// ============================================================================

const EMAIL_TYPES: { value: EmailType; label: string }[] = [
  { value: "onboarding_incomplete_1h", label: "P1 - Onboarding incomplete (1h)" },
  { value: "onboarding_incomplete_24h", label: "P1 - Onboarding incomplete (24h)" },
  { value: "onboarding_incomplete_72h", label: "P1 - Onboarding incomplete (72h)" },
  { value: "welcome", label: "P2 - Welcome" },
  { value: "no_call_nudge_24h", label: "P2 - No call nudge (24h)" },
  { value: "no_call_nudge_72h", label: "P2 - No call nudge (72h)" },
  { value: "first_call_followup", label: "P2 - First call followup" },
  { value: "schedule_nudge", label: "P2 - Schedule nudge" },
  { value: "reengagement_3d", label: "P3 - Re-engagement (3d)" },
  { value: "upgrade_nudge", label: "P4 - Upgrade nudge" },
];

// ============================================================================
// RENDER
// ============================================================================

export default function EmailPreviewPage() {
  const [selectedType, setSelectedType] = useState<EmailType>("welcome");
  const [html, setHtml] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    previewEmailHtml(selectedType)
      .then(setHtml)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load preview"))
      .finally(() => setLoading(false));
  }, [selectedType]);

  return (
    <>
      <div className="page-header">
        <h1>Email Preview</h1>
        <p>Preview engagement email templates as they appear to users</p>
      </div>

      <div className="page-content">
        {/* Controls */}
        <div style={{ display: "flex", gap: 12, marginBottom: 24, alignItems: "center" }}>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value as EmailType)}
            style={{
              background: "var(--bg-main)",
              border: "1px solid var(--border-color)",
              color: "var(--text-primary)",
              padding: "8px 12px",
              fontSize: 13,
              borderRadius: 0,
              outline: "none",
            }}
          >
            {EMAIL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          {loading && (
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Loading...</span>
          )}
        </div>

        {/* Error */}
        {error && (
          <div style={{ padding: 16, color: "#ef4444", fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        {/* Preview iframe */}
        {html && !error && (
          <div style={{ border: "1px solid var(--border-color)", background: "#f4f4f5" }}>
            <iframe
              srcDoc={html}
              title="Email preview"
              style={{
                width: "100%",
                height: 700,
                border: "none",
                display: "block",
              }}
            />
          </div>
        )}
      </div>
    </>
  );
}
