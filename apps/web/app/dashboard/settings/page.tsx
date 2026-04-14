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
import { Brain, Calendar, CreditCard, Lightbulb, Mail, Settings, Volume2 } from "lucide-react";
import GeneralTab from "./GeneralTab";
import EmailTab from "./EmailTab";
import VoiceTab from "./VoiceTab";
import MemoriesTab from "./MemoriesTab";
import BillingTab from "./BillingTab";
import FeatureRequestsTab from "./FeatureRequestsTab";
import ScheduleTab from "./ScheduleTab";

// ============================================================================
// CONSTANTS
// ============================================================================

const TABS = [
  { id: "general", label: "General", icon: Settings },
  { id: "email", label: "Email", icon: Mail },
  { id: "voice", label: "Voice", icon: Volume2 },
  { id: "memories", label: "Memories", icon: Brain },
  { id: "schedule", label: "Schedule", icon: Calendar },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "feature-requests", label: "Feature Requests", icon: Lightbulb },
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
    <div className="flex-1 flex flex-col" style={{ padding: 0 }}>
      {/* Tab bar */}
      <div className="flex gap-2 px-4 py-4 md:px-8 md:pt-6 md:pb-4 border-b border-[var(--border-color)] shrink-0 overflow-x-auto">
        {TABS.map((tab) => {
          const Icon = tab.icon;

          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: "6px 14px",
                background: activeTab === tab.id ? "var(--btn-primary-bg)" : "var(--bg-main)",
                border: "1px solid " + (activeTab === tab.id ? "transparent" : "var(--border-color)"),
                borderRadius: 0,
                color: activeTab === tab.id ? "var(--btn-primary-text)" : "var(--text-primary)",
                fontWeight: 500,
                cursor: "pointer",
                fontSize: "13px",
                transition: "all 0.1s ease",
              }}
              className="inline-flex items-center gap-2 whitespace-nowrap"
            >
              <Icon size={16} strokeWidth={1.75} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex-1 w-full px-4 py-6 md:px-[64px] md:py-[48px]">
        {activeTab === "general" && <GeneralTab />}
        {activeTab === "email" && <EmailTab />}
        {activeTab === "voice" && <VoiceTab />}
        {activeTab === "memories" && <MemoriesTab />}
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
