/**
 * Root layout for the web dashboard.
 *
 * Minimal shell -- Phase 2 will add Supabase provider and navigation.
 */

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Voice Email Assistant",
  description: "Manage your email with voice",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="font-[family-name:var(--font-geist-sans)] antialiased">{children}</body>
    </html>
  );
}
