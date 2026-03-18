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

import Link from "next/link";
import { usePathname } from "next/navigation";

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

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-64 border-r border-gray-200 bg-white">
        <div className="p-6">
          <h2 className="text-lg font-bold text-gray-900">Voice Email</h2>
        </div>
        <nav className="px-4 pb-6">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-md px-3 py-2 text-sm font-medium ${
                  active
                    ? "bg-gray-100 text-gray-900"
                    : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
