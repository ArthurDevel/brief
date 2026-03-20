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
      if (!res.ok) throw new Error("Failed to fetch");
      const data: FeatureRequest[] = await res.json();
      setRequests(data);
      setError(null);
    } catch {
      setError("Failed to load feature requests");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!description.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/feature-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description.trim() }),
      });

      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? "Failed to submit feature request");
        return;
      }

      setDescription("");
      await loadRequests();
    } catch {
      setError("Failed to submit feature request");
    } finally {
      setSubmitting(false);
    }
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  if (loading) {
    return <p className="text-gray-500">Loading...</p>;
  }

  return (
    <div>
      {error && (
        <div className="mb-6 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Submit form */}
      <div className="mb-8 border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-black">Submit a Request</h2>
        <form onSubmit={handleSubmit} className="flex gap-3">
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the feature you'd like..."
            className="flex-1 border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
          />
          <button
            type="submit"
            disabled={submitting || !description.trim()}
            className="bg-black px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {submitting ? "Submitting..." : "Submit"}
          </button>
        </form>
      </div>

      {/* Requests table */}
      <div className="border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-black">
          Your Requests ({requests.length})
        </h2>

        {requests.length === 0 ? (
          <p className="text-sm text-gray-500">No feature requests yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="pb-2 font-medium text-gray-500">Description</th>
                <th className="pb-2 font-medium text-gray-500">Source</th>
                <th className="pb-2 font-medium text-gray-500">Date</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((req) => (
                <tr key={req.id} className="border-b border-gray-100">
                  <td className="py-3 text-gray-800">{req.description}</td>
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
                  <td className="py-3 text-gray-500">
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
