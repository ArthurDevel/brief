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
      appearance={{
        theme: ThemeSupa,
        variables: {
          default: {
            colors: {
              brand: "var(--btn-primary-bg)",
              brandAccent: "var(--btn-primary-hover)",
              inputText: "var(--text-primary)",
              inputBackground: "var(--bg-main)",
              inputBorder: "var(--border-color)",
              inputBorderFocus: "var(--btn-primary-bg)",
              inputBorderHover: "var(--btn-primary-bg)",
            },
            borderWidths: {
              buttonBorderWidth: "0px",
              inputBorderWidth: "1px",
            },
            radii: {
              borderRadiusButton: "0px",
              buttonBorderRadius: "0px",
              inputBorderRadius: "0px",
            },
            fonts: {
              bodyFontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif",
              inputFontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif",
              buttonFontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif",
              labelFontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif",
            },
            fontSizes: {
              baseBodySize: "13px",
              baseInputSize: "13px",
              baseLabelSize: "12px",
              baseButtonSize: "13px",
            },
          },
        },
      }}
      providers={[]}
      redirectTo={`${window.location.origin}/api/auth/callback`}
    />
  );
}
