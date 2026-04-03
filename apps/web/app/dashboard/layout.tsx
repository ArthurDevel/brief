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

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CallProvider } from "@/contexts/CallContext";
import ActiveCallBar from "@/components/ActiveCallBar";
import { createBrowserClient } from "@/lib/supabase/client";
import { Home, Phone, Activity, Clock, Settings, Menu, X, User, LogOut } from "lucide-react";

// ============================================================================
// CONSTANTS
// ============================================================================

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview", icon: Home },
  { href: "/dashboard/sessions", label: "Sessions", icon: Clock },
  { href: "/dashboard/call", label: "Call", icon: Phone },
  { href: "/dashboard/actions", label: "Actions", icon: Activity },
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
  const router = useRouter();
  const [isFreePlan, setIsFreePlan] = useState<boolean>(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState<boolean>(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Close Mobile Menu automatically upon navigation
  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    fetch("/api/billing/usage")
      .then((res) => res.json())
      .then((data) => setIsFreePlan(data.plan === "free"))
      .catch(() => {});
  }, []);

  // Fetch the authenticated user's email
  useEffect(() => {
    const supabase = createBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null);
    });
  }, []);

  // Close user menu when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setIsUserMenuOpen(false);
      }
    }
    if (isUserMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isUserMenuOpen]);

  /**
   * Signs the user out and redirects to the login page.
   */
  async function handleLogout(): Promise<void> {
    const supabase = createBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <CallProvider>
      <div className="flex flex-col h-screen">
        <ActiveCallBar />
        <div className="flex flex-1 min-h-0 relative">

        {/* Mobile Sidebar Overlay */}
        {isMobileMenuOpen && (
          <div 
            className="fixed inset-0 z-40 bg-black/20 md:hidden transition-opacity"
            onClick={() => setIsMobileMenuOpen(false)}
          />
        )}

        {/* Sidebar */}
        <aside className={`sidebar ${isMobileMenuOpen ? "open" : ""}`}>
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

          {/* User menu */}
          {userEmail && (
            <div className="sidebar-user-menu" ref={userMenuRef}>
              {isUserMenuOpen && (
                <button className="sidebar-user-logout" onClick={handleLogout}>
                  <LogOut size={14} strokeWidth={1.75} />
                  Log out
                </button>
              )}
              <button
                className="sidebar-user-button"
                onClick={() => setIsUserMenuOpen((prev) => !prev)}
              >
                <User size={16} strokeWidth={1.75} />
                <span className="sidebar-user-email">{userEmail}</span>
              </button>
            </div>
          )}
        </aside>

        {/* Main content */}
        <main className="flex-1 flex flex-col min-h-0 bg-[var(--bg-main)] w-full overflow-y-auto relative">
          {/* Mobile Header */}
          <header className="md:hidden sticky top-0 z-20 flex-shrink-0 flex items-center justify-between p-4 border-b border-[var(--border-color)] bg-[var(--bg-main)]">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 26, height: 26, backgroundColor: "var(--text-primary)", color: "var(--bg-main)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-ibm-plex-serif), serif", fontSize: "15px", lineHeight: 1, paddingTop: 2 }}>
                B
              </div>
              <span style={{ fontSize: "20px", fontWeight: "400", fontFamily: "var(--font-ibm-plex-serif), serif", letterSpacing: "-0.5px", color: "var(--text-primary)" }}>
                BrewDock
              </span>
            </div>
            <button 
              onClick={() => setIsMobileMenuOpen(true)} 
              className="p-1 -mr-1 text-[var(--text-primary)]"
              aria-label="Open menu"
            >
              <Menu size={24} />
            </button>
          </header>

          {children}
        </main>

        </div>
      </div>
    </CallProvider>
  );
}
