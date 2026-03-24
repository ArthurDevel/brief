/**
 * Settings page with tabbed navigation for General, Billing, Feature Requests, and Schedule.
 *
 * Renders a tab bar at the top and conditionally shows the active tab content.
 * Tab state is managed via URL search params (?tab=general|billing|feature-requests|schedule).
 *
 * Responsibilities:
 * - Render tab navigation
 * - Show the active tab's content component
 */

"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import GeneralTab from "./GeneralTab";
import EmailTab from "./EmailTab";
import BillingTab from "./BillingTab";
import FeatureRequestsTab from "./FeatureRequestsTab";
import ScheduleTab from "./ScheduleTab";

// ============================================================================
// CONSTANTS
// ============================================================================

const TABS = [
  { id: "general", label: "General" },
  { id: "email", label: "Email" },
  { id: "schedule", label: "Schedule" },
  { id: "billing", label: "Billing" },
  { id: "feature-requests", label: "Feature Requests" },
] as const;

type TabId = (typeof TABS)[number]["id"];

// ============================================================================
// COMPONENTS
// ============================================================================

/**
 * Inner component that reads search params (requires Suspense boundary).
 */
function SettingsContent() {
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") as TabId | null;
  const [activeTab, setActiveTab] = useState<TabId>(
    initialTab && TABS.some((t) => t.id === initialTab) ? initialTab : "general"
  );

  return (
    <div>
      <h1 className="mb-6 text-3xl font-extrabold tracking-tight text-black">Settings</h1>

      {/* Tab bar */}
      <div className="mb-8 flex border-b border-gray-200">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "border-b-2 border-black text-black font-bold"
                : "text-gray-500 hover:text-black"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "general" && <GeneralTab />}
      {activeTab === "email" && <EmailTab />}
      {activeTab === "billing" && <BillingTab />}
      {activeTab === "feature-requests" && <FeatureRequestsTab />}
      {activeTab === "schedule" && <ScheduleTab />}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">Loading...</p>}>
      <SettingsContent />
    </Suspense>
  );
}
