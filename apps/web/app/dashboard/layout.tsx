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

// ============================================================================
// CONSTANTS
// ============================================================================

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/call", label: "Call" },
  { href: "/dashboard/actions", label: "Actions" },
  { href: "/dashboard/sessions", label: "Sessions" },
  { href: "/dashboard/settings", label: "Settings" },
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
        <aside className="flex w-64 flex-col border-r border-gray-200 bg-white">
          <div className="p-6">
            <h2 className="text-xl font-extrabold tracking-tight text-black">Voice Email</h2>
          </div>
          <nav className="px-4 pb-6">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.href, pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`block px-3 py-2 text-sm font-medium ${
                    active
                      ? "bg-gray-100 text-black font-bold"
                      : "text-gray-600 hover:bg-gray-50 hover:text-black"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {isFreePlan && (
            <div className="mt-auto px-4 pb-4">
              <Link
                href="/dashboard/settings?tab=billing"
                className="block rounded-lg bg-black px-4 py-3 text-center text-sm font-medium text-white shadow-lg hover:bg-gray-800"
              >
                Upgrade to Pro for more calling time
              </Link>
            </div>
          )}
        </aside>

        {/* Main content */}
        <main
          className="flex-1 overflow-auto p-8"
          style={{
            backgroundImage: "radial-gradient(#d4d4d8 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        >
          {children}
        </main>
        </div>
      </div>
    </CallProvider>
  );
}
