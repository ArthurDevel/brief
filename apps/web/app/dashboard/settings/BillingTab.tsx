/**
 * Billing tab -- plan info, usage progress, plan comparison, and upgrade modal.
 *
 * Shows the user's current plan, usage progress bar, hours remaining,
 * billing period dates, and a plan comparison table with an inline upgrade
 * button that opens a payment modal for upgrading.
 *
 * Responsibilities:
 * - Fetch usage from /api/billing/usage
 * - Display current plan and usage metrics
 * - Show plan comparison table with inline upgrade button
 * - Show payment modal for upgrading to Pro
 * - Refresh usage data after successful upgrade
 */

"use client";

import { useEffect, useState } from "react";
import { Lock, CreditCard, Landmark, Wallet, CircleDollarSign, Check } from "lucide-react";
import type { UsageInfo, UpgradeResponse } from "@/lib/types";

// ============================================================================
// CONSTANTS
// ============================================================================

const PLANS = [
  { name: "Free", hours: 1, price: "$0/month" },
  { name: "Pro", hours: 5, price: "$20/month" },
];

type PaymentMethod = "credit-card" | "ideal" | "bancontact" | "paypal";

const PAYMENT_METHODS: { id: PaymentMethod; label: string }[] = [
  { id: "credit-card", label: "Credit Card" },
  { id: "ideal", label: "iDEAL" },
  { id: "bancontact", label: "Bancontact" },
  { id: "paypal", label: "PayPal" },
];

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * Billing tab showing plan info, usage, plan comparison, and upgrade flow.
 * @returns The billing tab UI
 */
export default function BillingTab(): JSX.Element {
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState<boolean>(false);

  useEffect(() => {
    fetchUsage();
  }, []);

  /**
   * Fetch current usage data from the billing API.
   */
  async function fetchUsage(): Promise<void> {
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

  /**
   * Re-fetch usage data after a successful upgrade.
   */
  function refreshUsage(): void {
    setShowPaymentModal(false);
    fetchUsage();
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  if (loading) {
    return <p className="text-gray-500">Loading...</p>;
  }

  if (error || !usage) {
    return (
      <div className="bg-red-50 p-4 text-sm text-red-700">
        {error ?? "Failed to load billing info"}
      </div>
    );
  }

  const usagePercent =
    usage.hoursLimit > 0
      ? Math.min(100, Math.round((usage.hoursUsed / usage.hoursLimit) * 100))
      : 0;

  return (
    <div>
      {/* Current plan + usage */}
      <div className="mb-8 border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-black">Current Plan</h2>

        <p className="mb-2 text-sm text-gray-600">
          <span className="font-medium">Plan:</span>{" "}
          <span className="capitalize">{usage.plan}</span>
        </p>

        <p className="mb-4 text-sm text-gray-600">
          <span className="font-medium">Period:</span> {usage.periodStart} to{" "}
          {usage.periodEnd}
        </p>

        {/* Usage progress bar */}
        <div className="mb-2">
          <div className="flex justify-between text-sm text-gray-600">
            <span>{usage.hoursUsed.toFixed(2)}h used</span>
            <span>{usage.hoursLimit}h limit</span>
          </div>
          <div className="mt-1 h-3 w-full bg-gray-200">
            <div
              className={`h-3 ${usagePercent >= 90 ? "bg-red-500" : "bg-black"}`}
              style={{ width: `${usagePercent}%` }}
            />
          </div>
        </div>

        <p className="text-sm text-gray-500">
          {usage.hoursRemaining.toFixed(2)}h remaining
        </p>
      </div>

      {/* Plan comparison */}
      <div className="mb-8 border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-black">Plans</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="pb-2 font-medium text-gray-500">Plan</th>
              <th className="pb-2 font-medium text-gray-500">Call Hours</th>
              <th className="pb-2 font-medium text-gray-500">Price</th>
              <th className="w-0 pb-2" />
            </tr>
          </thead>
          <tbody>
            {PLANS.map((plan) => {
              const isCurrent = plan.name.toLowerCase() === usage.plan;
              const showUpgrade =
                plan.name === "Pro" && usage.plan === "free";

              return (
                <tr
                  key={plan.name}
                  className={`border-b border-gray-100 ${isCurrent ? "bg-black/5" : ""}`}
                >
                  <td className="py-3 font-medium">
                    {plan.name}
                    {isCurrent && (
                      <span className="ml-2 text-xs font-medium text-black">
                        (current)
                      </span>
                    )}
                  </td>
                  <td className="py-3 text-gray-600">{plan.hours}h / month</td>
                  <td className="py-3 text-gray-600">{plan.price}</td>
                  <td className="py-3 text-right">
                    {showUpgrade && (
                      <button
                        onClick={() => setShowPaymentModal(true)}
                        className="cursor-pointer bg-black px-4 py-1 text-xs font-medium text-white hover:bg-gray-800"
                      >
                        Upgrade
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Payment modal */}
      {showPaymentModal && (
        <PaymentModal
          open={showPaymentModal}
          onClose={() => setShowPaymentModal(false)}
          onSuccess={refreshUsage}
        />
      )}
    </div>
  );
}

// ============================================================================
// COMPONENTS
// ============================================================================

/**
 * Payment checkout modal for upgrading to the Pro plan.
 * Shows order summary, payment method selection, and handles the upgrade API call.
 *
 * @param props.open - whether the modal is visible
 * @param props.onClose - callback to close the modal
 * @param props.onSuccess - callback after a successful upgrade (refreshes usage)
 * @returns The payment modal UI
 */
function PaymentModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}): JSX.Element | null {
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethod | null>(
    null,
  );
  const [upgrading, setUpgrading] = useState<boolean>(false);
  const [success, setSuccess] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  /**
   * POST to the upgrade endpoint and update modal state.
   */
  async function handleUpgrade(): Promise<void> {
    setUpgrading(true);
    setError(null);

    try {
      const res = await fetch("/api/billing/upgrade", { method: "POST" });
      const data: UpgradeResponse = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Upgrade failed");
      }

      setSuccess(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upgrade failed";
      setError(message);
    } finally {
      setUpgrading(false);
    }
  }

  /**
   * Handle overlay click -- close only when not processing.
   */
  function handleOverlayClick(): void {
    if (!upgrading) {
      onClose();
    }
  }

  // -- Success view --
  if (success) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        onClick={handleOverlayClick}
      >
        <div
          className="w-full max-w-md bg-white p-6 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex flex-col items-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center bg-black">
              <Check className="h-6 w-6 text-white" />
            </div>
            <h2 className="mb-2 text-lg font-bold text-black">
              You are on Pro!
            </h2>
            <p className="mb-6 text-sm text-gray-600">
              We are still setting up our payment system. Enjoy a free month of
              Pro on us!
            </p>
            <button
              onClick={onSuccess}
              className="bg-black px-6 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              Go to Billing
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -- Checkout view --
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleOverlayClick}
    >
      <div
        className="w-full max-w-md bg-white shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 className="text-lg font-bold text-black">Checkout</h2>
          <button
            onClick={onClose}
            disabled={upgrading}
            className="text-gray-400 hover:text-black disabled:opacity-50"
          >
            <span className="text-xl leading-none">&times;</span>
          </button>
        </div>

        {/* Order summary */}
        <div className="bg-gray-50 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-black">Pro Plan</p>
              <p className="text-xs text-gray-500">
                5h voice calls per month
              </p>
            </div>
            <p className="text-sm font-medium text-black">$20/month</p>
          </div>
        </div>

        <div className="border-t border-gray-200" />

        {/* Payment method selection */}
        <div className="px-6 py-4">
          <p className="mb-3 text-sm font-medium text-gray-500">
            Payment method
          </p>
          <div className="flex flex-col gap-2">
            {PAYMENT_METHODS.map((method) => {
              const isSelected = selectedMethod === method.id;
              return (
                <button
                  key={method.id}
                  onClick={() => setSelectedMethod(method.id)}
                  disabled={upgrading}
                  className={`flex items-center gap-3 border p-3 text-left text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 ${
                    isSelected
                      ? "border-black bg-black/5"
                      : "border-gray-200 bg-white"
                  }`}
                >
                  {/* Radio indicator */}
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center border ${
                      isSelected ? "border-black" : "border-gray-300"
                    }`}
                    style={{ borderRadius: "50%" }}
                  >
                    {isSelected && (
                      <span
                        className="h-2 w-2 bg-black"
                        style={{ borderRadius: "50%" }}
                      />
                    )}
                  </span>

                  {/* Icon */}
                  <PaymentMethodIcon method={method.id} />

                  {/* Label */}
                  <span>{method.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="border-t border-gray-200" />

        {/* Error message */}
        {error && (
          <div className="mx-6 mt-4 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-1 text-xs text-gray-400">
            <Lock className="h-3 w-3" />
            <span>Secure payment with Stripe</span>
          </div>
          <button
            onClick={handleUpgrade}
            disabled={selectedMethod === null || upgrading}
            className={`px-6 py-2 text-sm font-medium text-white ${
              selectedMethod === null || upgrading
                ? "cursor-not-allowed bg-gray-400"
                : "bg-black hover:bg-gray-800"
            }`}
          >
            {upgrading ? "Processing..." : "Pay $20/month"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the appropriate icon for a payment method.
 * @param props.method - the payment method identifier
 * @returns An icon element for the given payment method
 */
function PaymentMethodIcon({
  method,
}: {
  method: PaymentMethod;
}): JSX.Element {
  switch (method) {
    case "credit-card":
      return <CreditCard className="h-5 w-5 text-gray-600" />;
    case "ideal":
      return <Landmark className="h-5 w-5 text-gray-600" />;
    case "bancontact":
      return <Wallet className="h-5 w-5 text-gray-600" />;
    case "paypal":
      return <CircleDollarSign className="h-5 w-5 text-gray-600" />;
  }
}
