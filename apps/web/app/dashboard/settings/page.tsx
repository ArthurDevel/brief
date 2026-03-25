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
    <div className="flex-1 flex flex-col h-full">
      <div style={{ padding: "48px 64px 24px", flexShrink: 0 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.5px", margin: 0 }}>Settings</h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4, margin: 0 }}>Configure your agent and preferences.</p>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 64px 48px" }}>
        {/* Tab bar */}
        <div className="mb-8 flex border-b border-[var(--border-color)]">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-[13px] font-medium transition-colors ${
                activeTab === tab.id
                  ? "border-b-2 border-[var(--text-primary)] text-[var(--text-primary)] font-semibold"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
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
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<p className="text-[var(--text-secondary)]">Loading...</p>}>
      <SettingsContent />
    </Suspense>
  );
}
