/**
 * Billing page -- plan info, usage progress, and plan comparison.
 *
 * Shows the user's current plan, usage progress bar, hours remaining,
 * billing period dates, a plan comparison table, and a disabled
 * "Upgrade to Pro" button (Stripe not wired up for MVP).
 *
 * Responsibilities:
 * - Fetch usage from /api/billing/usage
 * - Display current plan and usage metrics
 * - Show plan comparison table
 * - Show upgrade button (disabled, coming soon)
 */

"use client";

import { useEffect, useState } from "react";
import type { UsageInfo } from "@/lib/types";

// ============================================================================
// CONSTANTS
// ============================================================================

const PLANS = [
  { name: "Free", hours: 1, price: "$0/month" },
  { name: "Pro", hours: 5, price: "$9.99/month" },
];

// ============================================================================
// RENDER
// ============================================================================

export default function BillingPage() {
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/billing/usage");
        if (!res.ok) throw new Error("Failed to fetch usage");
        const data: UsageInfo = await res.json();
        setUsage(data);
      } catch {
        setError("Failed to load billing info");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div>
        <h1 className="mb-8 text-2xl font-bold text-gray-900">Billing</h1>
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  if (error || !usage) {
    return (
      <div>
        <h1 className="mb-8 text-2xl font-bold text-gray-900">Billing</h1>
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
          {error ?? "Failed to load billing info"}
        </div>
      </div>
    );
  }

  const usagePercent = usage.hoursLimit > 0
    ? Math.min(100, Math.round((usage.hoursUsed / usage.hoursLimit) * 100))
    : 0;

  return (
    <div>
      <h1 className="mb-8 text-2xl font-bold text-gray-900">Billing</h1>

      {/* Current plan + usage */}
      <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-800">Current Plan</h2>

        <p className="mb-2 text-sm text-gray-600">
          <span className="font-medium">Plan:</span>{" "}
          <span className="capitalize">{usage.plan}</span>
        </p>

        <p className="mb-4 text-sm text-gray-600">
          <span className="font-medium">Period:</span>{" "}
          {usage.periodStart} to {usage.periodEnd}
        </p>

        {/* Usage progress bar */}
        <div className="mb-2">
          <div className="flex justify-between text-sm text-gray-600">
            <span>{usage.hoursUsed.toFixed(2)}h used</span>
            <span>{usage.hoursLimit}h limit</span>
          </div>
          <div className="mt-1 h-3 w-full rounded-full bg-gray-200">
            <div
              className={`h-3 rounded-full ${usagePercent >= 90 ? "bg-red-500" : "bg-blue-600"}`}
              style={{ width: `${usagePercent}%` }}
            />
          </div>
        </div>

        <p className="text-sm text-gray-500">
          {usage.hoursRemaining.toFixed(2)}h remaining
        </p>
      </div>

      {/* Plan comparison */}
      <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-800">Plans</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="pb-2 font-medium text-gray-500">Plan</th>
              <th className="pb-2 font-medium text-gray-500">Call Hours</th>
              <th className="pb-2 font-medium text-gray-500">Price</th>
            </tr>
          </thead>
          <tbody>
            {PLANS.map((plan) => (
              <tr
                key={plan.name}
                className={`border-b border-gray-100 ${
                  plan.name.toLowerCase() === usage.plan ? "bg-blue-50" : ""
                }`}
              >
                <td className="py-3 font-medium">
                  {plan.name}
                  {plan.name.toLowerCase() === usage.plan && (
                    <span className="ml-2 text-xs text-blue-600">(current)</span>
                  )}
                </td>
                <td className="py-3 text-gray-600">{plan.hours}h / month</td>
                <td className="py-3 text-gray-600">{plan.price}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Upgrade button */}
      {usage.plan === "free" && (
        <div className="relative inline-block" title="Coming soon -- Stripe integration pending">
          <button
            disabled
            className="cursor-not-allowed rounded-md bg-gray-400 px-6 py-2 text-sm font-medium text-white"
          >
            Upgrade to Pro
          </button>
          <span className="ml-3 text-xs text-gray-500">Coming soon</span>
        </div>
      )}
    </div>
  );
}
