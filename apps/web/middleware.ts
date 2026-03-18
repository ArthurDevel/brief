/**
 * Supabase auth middleware for the Next.js web app.
 *
 * Checks the Supabase session on every request and enforces access control:
 * - Unauthenticated users are redirected to /login (except for /login and /api/auth routes)
 * - Authenticated users on /login are redirected to /dashboard
 * - Refreshes the Supabase session cookie on each request
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Routes that do not require authentication. */
const PUBLIC_ROUTES = ["/login", "/api/auth"];

// ============================================================================
// MIDDLEWARE
// ============================================================================

/**
 * Checks Supabase session and redirects based on auth state.
 * @param request - The incoming Next.js request
 * @returns NextResponse with appropriate redirect or pass-through
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public routes through without auth check
  const isPublicRoute = PUBLIC_ROUTES.some((route) => pathname.startsWith(route))
    || pathname.match(/^\/api\/sessions\/[^/]+\/end-of-session$/) !== null;

  // Create a response to pass through (we may modify cookies on it)
  let response = NextResponse.next({ request: { headers: request.headers } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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

  return response;
}

export const config = {
  matcher: [
    // Match all routes except static files and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
