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
    <main className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-center text-2xl font-bold text-gray-900">
          Voice Email Assistant
        </h1>
        <LoginForm />
      </div>
    </main>
  );
}
