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

import Link from "next/link";

// ============================================================================
// CONSTANTS
// ============================================================================

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/actions", label: "Actions" },
  { href: "/dashboard/history", label: "History" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/dashboard/billing", label: "Billing" },
  { href: "/dashboard/feature-requests", label: "Feature Requests" },
] as const;

// ============================================================================
// RENDER
// ============================================================================

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-64 border-r border-gray-200 bg-white">
        <div className="p-6">
          <h2 className="text-lg font-bold text-gray-900">Voice Email</h2>
        </div>
        <nav className="px-4 pb-6">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded-md px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
