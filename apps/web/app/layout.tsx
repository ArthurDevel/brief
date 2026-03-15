/**
 * Root layout for the web dashboard.
 *
 * Minimal shell -- Phase 2 will add Supabase provider and navigation.
 */

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voice Email Assistant",
  description: "Manage your email with voice",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
