/**
 * Feature Requests tab -- list submitted requests and submit new ones.
 *
 * Shows a table of the user's feature requests with description, source,
 * and date. Includes a form to submit new requests from the dashboard.
 *
 * Responsibilities:
 * - Fetch feature requests from /api/feature-requests
 * - Display requests in a table
 * - Submit new requests via POST /api/feature-requests
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import type { FeatureRequest } from "@/lib/types";
import { getDashboardErrorMessage } from "@/lib/errors/dashboardErrors";
import {
  buildDashboardErrorFromResponse,
  logAndMapDashboardError,
} from "@/lib/errors/mapDashboardError";
import {
  SETTINGS_FIELD_CARD,
  SETTINGS_FIELD_LABEL,
  SETTINGS_MAX_WIDTH,
  SETTINGS_SECTION_COPY,
  SETTINGS_TEXTAREA,
} from "./settingsUi";

// ============================================================================
// CONSTANTS
// ============================================================================

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

// ============================================================================
// COMPONENT
// ============================================================================

export default function FeatureRequestsTab() {
  const [requests, setRequests] = useState<FeatureRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadRequests = useCallback(async () => {
    try {
      const res = await fetch("/api/feature-requests");
      if (!res.ok) {
        throw await buildDashboardErrorFromResponse(res, {
          code: "FEATURE_REQUEST_LOAD_FAILED",
          error: "Failed to fetch",
        });
      }
      const data: FeatureRequest[] = await res.json();
      setRequests(data);
      setError(null);
    } catch (err) {
      setError(logAndMapDashboardError(err, "settings-feature-requests", "FEATURE_REQUEST_LOAD_FAILED"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!description.trim()) {
      setError(getDashboardErrorMessage("FEATURE_REQUEST_EMPTY"));
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/feature-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description.trim() }),
      });

      if (!res.ok) {
        const apiError = await buildDashboardErrorFromResponse(res, {
          code: "FEATURE_REQUEST_SUBMIT_FAILED",
          error: "Failed to submit feature request",
        });
        setError(
          logAndMapDashboardError(
            apiError,
            "settings-feature-requests",
            "FEATURE_REQUEST_SUBMIT_FAILED"
          )
        );
        return;
      }

      setDescription("");
      await loadRequests();
    } catch (err) {
      setError(
        logAndMapDashboardError(err, "settings-feature-requests", "FEATURE_REQUEST_SUBMIT_FAILED")
      );
    } finally {
      setSubmitting(false);
    }
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  if (loading) {
    return <p className="text-[var(--text-secondary)]">Loading...</p>;
  }

  return (
    <div>
      {error && (
        <div className="mb-6 bg-red-50 p-4 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {/* Submit form */}
      <div className="settings-panel">
        <h2 >Submit a Request</h2>
        <p className={SETTINGS_SECTION_COPY}>
          Tell us what would make BrewDock more useful for your workflow.
        </p>
        <form onSubmit={handleSubmit} className={`${SETTINGS_MAX_WIDTH} ${SETTINGS_FIELD_CARD}`}>
          <label className={SETTINGS_FIELD_LABEL}>Feature request</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the feature you'd like..."
            rows={4}
            className={SETTINGS_TEXTAREA}
          />
          <button
            type="submit"
            disabled={submitting || !description.trim()}
            className="mt-3 w-full border border-zinc-200 px-4 py-3 text-[15px] font-semibold text-black hover:bg-zinc-50 disabled:opacity-50"
          >
            {submitting ? "Submitting..." : "Submit"}
          </button>
        </form>
      </div>

      {/* Requests table */}
      <div className="settings-panel">
        <h2 >
          Your Requests ({requests.length})
        </h2>

        {requests.length === 0 ? (
          <p className={`${SETTINGS_MAX_WIDTH} text-[15px] text-[var(--text-secondary)]`}>No feature requests yet.</p>
        ) : (
          <div className={`${SETTINGS_MAX_WIDTH} space-y-3`}>
            {requests.map((req) => (
              <div key={req.id} className={SETTINGS_FIELD_CARD}>
                <p className="mb-3 text-[15px] leading-relaxed text-[var(--text-primary)]">
                  {req.description}
                </p>
                <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--text-secondary)]">
                  <span
                    className={`inline-block px-2 py-0.5 text-xs font-bold ${
                      req.source === "voice"
                        ? "bg-purple-100 text-purple-700"
                        : "bg-blue-100 text-blue-700"
                    }`}
                  >
                    {req.source}
                  </span>
                  <span>{new Date(req.createdAt).toLocaleDateString("en-US", DATE_FORMAT)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
