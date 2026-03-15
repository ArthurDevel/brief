/**
 * Landing page -- redirects to /dashboard.
 *
 * Auth middleware handles the redirect to /login if not authenticated.
 */

import { redirect } from "next/navigation";

export default function Home() {
  redirect("/dashboard");
}
