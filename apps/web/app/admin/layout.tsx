/**
 * Admin layout with sidebar navigation.
 *
 * Wraps all /admin/* pages with a persistent sidebar. Access is
 * restricted to ADMIN_USER_IDS via middleware -- this layout assumes
 * the user is already authorized.
 *
 * Responsibilities:
 * - Render the admin sidebar with navigation links
 * - Display the current page content in the main area
 * - Provide a link back to the user dashboard
 */

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createBrowserClient } from "@/lib/supabase/client";
import { Mail, Eye, Menu, User, LogOut, ArrowLeft, MessageSquare } from "lucide-react";

// ============================================================================
// CONSTANTS
// ============================================================================

const NAV_ITEMS = [
  { href: "/admin/transactional", label: "Transactional Emails", icon: Mail },
  { href: "/admin/transactional/preview", label: "Email Preview", icon: Eye },
  { href: "/admin/whatsapp", label: "WhatsApp Conversations", icon: MessageSquare },
] as const;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Checks if a nav item is active based on the current pathname.
 * Matches exactly, or as a prefix only if the nav item is the longest match
 * (so /admin/transactional does not match /admin/transactional/preview).
 * @param href - the nav item's href
 * @param pathname - the current pathname
 * @returns whether the nav item is active
 */
function isActive(href: string, pathname: string): boolean {
  if (pathname === href) return true;
  // Only match as prefix if no other nav item is a better (longer) match
  if (pathname.startsWith(href + "/")) {
    return !NAV_ITEMS.some((item) => item.href !== href && pathname.startsWith(item.href) && item.href.length > href.length);
  }
  return false;
}

// ============================================================================
// RENDER
// ============================================================================

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState<boolean>(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Close mobile menu on navigation
  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [pathname]);

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
    <div className="flex flex-col h-screen">
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
              Admin
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

            <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border-color)" }}>
              <Link href="/dashboard" className="sidebar-item">
                <ArrowLeft size={16} strokeWidth={1.75} />
                Back to Dashboard
              </Link>
            </div>
          </div>

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
                Admin
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
  );
}
