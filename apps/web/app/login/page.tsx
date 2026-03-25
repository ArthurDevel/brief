/**
 * Login page with Supabase Auth UI.
 *
 * Dynamically loads the login form client-side only to avoid SSR issues
 * with Supabase environment variables during build.
 *
 * Responsibilities:
 * - Display the auth form (sign in / sign up)
 * - Redirect to /dashboard on successful auth (handled by middleware)
 */

"use client";

import dynamic from "next/dynamic";

const LoginForm = dynamic(() => import("./LoginForm"), { ssr: false });

// ============================================================================
// RENDER
// ============================================================================

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center" style={{ background: "var(--bg-main)" }}>
      <div className="w-full max-w-md p-8" style={{ background: "var(--bg-surface)", border: "1px solid var(--border-color)" }}>
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <div style={{ width: 32, height: 32, backgroundColor: "black", color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-ibm-plex-serif), serif", fontSize: "18px", lineHeight: 1, paddingTop: 2 }}>
            B
          </div>
          <span style={{ fontSize: "28px", fontWeight: "400", fontFamily: "var(--font-ibm-plex-serif), serif", letterSpacing: "-0.5px", color: "var(--text-primary)" }}>
            BrewDock
          </span>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
