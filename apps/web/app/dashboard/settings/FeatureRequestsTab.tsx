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
        <form onSubmit={handleSubmit} className="flex flex-col md:flex-row gap-3">
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the feature you'd like..."
            className="flex-1 border border-[var(--border-color)] w-full px-3 py-2 text-[13px] focus:border-[var(--btn-primary-bg)] focus:outline-none focus:ring-1 focus:ring-[var(--btn-primary-bg)]"
          />
          <button
            type="submit"
            disabled={submitting || !description.trim()}
            className="bg-[var(--btn-primary-bg)] px-4 py-2 text-[13px] font-medium text-white hover:bg-[var(--btn-primary-hover)] disabled:opacity-50"
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
          <p className="text-[13px] text-[var(--text-secondary)]">No feature requests yet.</p>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-[var(--border-color)]">
                <th className="pb-2 font-medium text-[var(--text-secondary)]">Description</th>
                <th className="pb-2 font-medium text-[var(--text-secondary)]">Source</th>
                <th className="pb-2 font-medium text-[var(--text-secondary)]">Date</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((req) => (
                <tr key={req.id} className="border-b border-[var(--border-color)]">
                  <td className="py-3 text-[var(--text-primary)]">{req.description}</td>
                  <td className="py-3">
                    <span
                      className={`inline-block px-2 py-0.5 text-xs font-bold ${
                        req.source === "voice"
                          ? "bg-purple-100 text-purple-700"
                          : "bg-blue-100 text-blue-700"
                      }`}
                    >
                      {req.source}
                    </span>
                  </td>
                  <td className="py-3 text-[var(--text-secondary)]">
                    {new Date(req.createdAt).toLocaleDateString("en-US", DATE_FORMAT)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
