/**
 * Supabase client factories for the Next.js web app.
 *
 * Provides browser-side and server-side Supabase clients.
 * Browser client uses the anon key for client-side auth.
 * Server client reads auth from cookies for API routes.
 *
 * Responsibilities:
 * - createBrowserClient: client-side Supabase client
 * - createServerClient: server-side client with cookie-based auth
 */

import { createBrowserClient as createBrowser } from "@supabase/ssr";
import { createServerClient as createServer } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { ReadonlyRequestCookies } from "next/dist/server/web/spec-extension/adapters/request-cookies";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Returns cookie domain options for cross-subdomain auth, or undefined if not configured.
 * When undefined, the cookieOptions key must be omitted entirely (not set to { domain: undefined }).
 * @returns Cookie options with domain, or undefined for default behavior
 */
export function getCookieOptions(): { domain: string } | undefined {
  const cookieDomain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN;
  return cookieDomain ? { domain: cookieDomain } : undefined;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Creates a client-side Supabase client using the anon key.
 * @returns Supabase client for browser use
 */
export function createBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  }
  if (!key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
  }

  const cookieOptions = getCookieOptions();
  return createBrowser(url, key, {
    ...(cookieOptions ? { cookieOptions } : {}),
  });
}

/**
 * Creates a Supabase client with service role permissions.
 * Used for Vault operations and other privileged server-side tasks.
 */
export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  }
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Creates a server-side Supabase client that reads auth from cookies.
 * @param cookies - The request cookies from Next.js
 * @returns Supabase client for server-side use
 */
export function createServerSupabaseClient(cookies: ReadonlyRequestCookies) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  }
  if (!key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
  }

  const cookieOptions = getCookieOptions();
  return createServer(url, key, {
    ...(cookieOptions ? { cookieOptions } : {}),
    cookies: {
      getAll() {
        return cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
        // Server components cannot set cookies -- this is expected to throw
        // in read-only contexts. API routes handle this correctly.
        cookiesToSet.forEach(({ name, value, options }) => {
          try {
            (cookies as unknown as { set: (name: string, value: string, options: Record<string, unknown>) => void }).set(name, value, options ?? {});
          } catch {
            // Swallow in server components where cookies are read-only
          }
        });
      },
    },
  });
}
