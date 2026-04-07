/**
 * Combined middleware for the Next.js web app.
 *
 * Composes two middleware layers:
 * - PostHog: proxies /ingest requests to PostHog servers (avoids ad blockers)
 *   and seeds an identity cookie so client + server share the same user ID
 * - Supabase auth: checks session on every request and enforces access control
 */

import { createServerClient } from "@supabase/ssr";
import { postHogMiddleware } from "@posthog/next";
import { NextResponse, type NextRequest } from "next/server";
import { getCookieOptions } from "./lib/supabase/client";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Routes that do not require authentication. */
const PUBLIC_ROUTES = ["/login", "/api/auth", "/ingest", "/api/trigger-call", "/api/user/email-accounts/notify"];

/** User IDs allowed to access /admin/* routes. */
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "").split(",").filter(Boolean);

/** PostHog middleware handler (proxy + identity cookie). */
const posthogHandler = postHogMiddleware({
  proxy: {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://eu.i.posthog.com",
  },
});

// ============================================================================
// MIDDLEWARE
// ============================================================================

/**
 * Runs PostHog proxy for /ingest routes, then Supabase auth for everything else.
 * @param request - The incoming Next.js request
 * @returns NextResponse with appropriate redirect or pass-through
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // CORS preflight for /api/trigger-call (cross-subdomain fetch from lander)
  if (pathname === "/api/trigger-call" && request.method === "OPTIONS") {
    const landerUrl = process.env.LANDER_URL || "";
    return new NextResponse(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": landerUrl,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
      },
    });
  }

  // PostHog proxy: delegate /ingest requests to @posthog/next
  if (pathname.startsWith("/ingest")) {
    return posthogHandler(request);
  }

  // Allow public routes through without auth check
  const isPublicRoute = PUBLIC_ROUTES.some((route) => pathname.startsWith(route))
    || pathname.match(/^\/api\/sessions\/[^/]+\/end-of-session$/) !== null;

  // Create a response to pass through (we may modify cookies on it)
  let response = NextResponse.next({ request: { headers: request.headers } });

  const cookieOptions = getCookieOptions();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      ...(cookieOptions ? { cookieOptions } : {}),
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          // Set cookies on the request (for downstream server components)
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          // Create a new response with updated request headers
          response = NextResponse.next({ request: { headers: request.headers } });
          // Set cookies on the response (for the browser)
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  // Refresh the session (this updates the cookie)
  const { data: { user } } = await supabase.auth.getUser();

  // Redirect authenticated users away from /login
  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  // Redirect unauthenticated users to /login (except public routes)
  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Block non-admin users from /admin/* routes
  if (user && pathname.startsWith("/admin") && !ADMIN_USER_IDS.includes(user.id)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // Match all routes except static files and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
