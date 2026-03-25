/**
 * Dashboard layout with sidebar navigation.
 *
 * Wraps all /dashboard/* pages with a persistent sidebar containing
 * navigation links. Uses server-side auth check to redirect
 * unauthenticated users (also enforced by middleware).
 *
 * Responsibilities:
 * - Render the sidebar navigation
 * - Display the current page content in the main area
 */

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CallProvider } from "@/contexts/CallContext";
import ActiveCallBar from "@/components/ActiveCallBar";
import { Home, Phone, Activity, Clock, Settings } from "lucide-react";

// ============================================================================
// CONSTANTS
// ============================================================================

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview", icon: Home },
  { href: "/dashboard/call", label: "Call", icon: Phone },
  { href: "/dashboard/actions", label: "Actions", icon: Activity },
  { href: "/dashboard/sessions", label: "Sessions", icon: Clock },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
] as const;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Checks if a nav item is active based on the current pathname.
 * "/dashboard" only matches exactly; other items match as prefixes.
 * @param href - the nav item's href
 * @param pathname - the current pathname
 * @returns whether the nav item is active
 */
function isActive(href: string, pathname: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname.startsWith(href);
}

// ============================================================================
// RENDER
// ============================================================================

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [isFreePlan, setIsFreePlan] = useState<boolean>(false);

  useEffect(() => {
    fetch("/api/billing/usage")
      .then((res) => res.json())
      .then((data) => setIsFreePlan(data.plan === "free"))
      .catch(() => {});
  }, []);

  return (
    <CallProvider>
      <div className="flex flex-col h-screen">
        <ActiveCallBar />
        <div className="flex flex-1 min-h-0">

        {/* Sidebar */}
        <aside className="sidebar">
          <div style={{ padding: "24px 16px 8px 24px", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, backgroundColor: "black", color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-ibm-plex-serif), serif", fontSize: "18px", lineHeight: 1, paddingTop: 2 }}>
              B
            </div>
            <span style={{ fontSize: "28px", fontWeight: "400", fontFamily: "var(--font-ibm-plex-serif), serif", letterSpacing: "-0.5px", color: "var(--text-primary)" }}>
              BrewDock
            </span>
          </div>

          <div className="sidebar-nav">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.href, pathname);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`sidebar-item ${active ? "active" : ""}`}
                >
                  <Icon size={16} strokeWidth={1.75} />
                  {item.label}
                </Link>
              );
            })}
          </div>

          {isFreePlan && (
            <div className="sidebar-footer">
              <div style={{ margin: "0 12px 8px", padding: "8px 10px", fontSize: 12, background: "var(--btn-primary-bg)", textAlign: "center" }}>
                <Link
                  href="/dashboard/settings?tab=billing"
                  style={{ color: "var(--btn-primary-text)", textDecoration: "none", display: "block", fontWeight: 500 }}
                >
                  Upgrade to Pro
                </Link>
              </div>
            </div>
          )}
        </aside>

        {/* Main content */}
        <main className="flex-1 flex flex-col min-h-0 bg-[var(--bg-main)]">
          {children}
        </main>

        </div>
      </div>
    </CallProvider>
  );
}
