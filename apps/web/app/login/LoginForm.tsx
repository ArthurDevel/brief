/**
 * Login form component using Supabase Auth UI.
 *
 * Client-only component that renders the Supabase Auth form for
 * email+password sign up and sign in.
 *
 * Responsibilities:
 * - Create the Supabase browser client
 * - Render the Auth UI component
 */

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Auth } from "@supabase/auth-ui-react";
import { ThemeSupa } from "@supabase/auth-ui-shared";
import { createBrowserClient } from "@/lib/supabase/client";

// ============================================================================
// RENDER
// ============================================================================

export default function LoginForm() {
  const supabase = createBrowserClient();
  const router = useRouter();

  // Redirect to dashboard when the user signs in
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") {
        router.push("/dashboard");
      }
    });

    return () => subscription.unsubscribe();
  }, [supabase, router]);

  return (
    <Auth
      supabaseClient={supabase}
      appearance={{ theme: ThemeSupa }}
      providers={[]}
      redirectTo={`${window.location.origin}/api/auth/callback`}
    />
  );
}
