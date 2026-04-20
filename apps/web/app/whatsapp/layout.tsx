import Link from "next/link";
import { cookies, headers } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { getWhatsAppSessionAccess } from "@/lib/whatsapp-session-access";
import { getWhatsAppProfile, sanitizeWhatsAppRedirectPath } from "@/lib/whatsapp-auth";
import WhatsAppAuthShell from "./_components/WhatsAppAuthShell";
import WhatsAppSignOutButton from "./_components/WhatsAppSignOutButton";
import { listWhatsAppConnectorDefinitions } from "./connectors/connectorDefinitions";

function getSessionIdFromWhatsAppPath(path: string): string | null {
  const match = path.match(/^\/whatsapp\/sessions\/([^/?#]+)/);
  return match?.[1] ?? null;
}

export default async function WhatsAppLayout({ children }: { children: React.ReactNode }) {
  const connectorDefinitions = listWhatsAppConnectorDefinitions();
  const cookieStore = await cookies();
  const headerStore = await headers();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  const currentPath = sanitizeWhatsAppRedirectPath(headerStore.get("x-current-path"));

  if (!user) {
    const sessionId = getSessionIdFromWhatsAppPath(currentPath);

    if (sessionId) {
      const sessionAccess = await getWhatsAppSessionAccess(sessionId);

      if (!sessionAccess) {
        return (
          <div className="min-h-screen bg-[var(--bg-main)] px-4 py-8 text-[var(--text-primary)] md:px-8">
            <div className="mx-auto max-w-xl settings-panel">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--text-secondary)]">
                WhatsApp Session
              </div>
              <h1 className="mt-2 text-[28px] font-semibold">Session not found</h1>
              <p className="mt-3 text-[14px] leading-6 text-[var(--text-secondary)]">
                This WhatsApp session link is invalid or no longer available.
              </p>
            </div>
          </div>
        );
      }

      return (
        <div className="min-h-screen bg-[var(--bg-main)] px-4 py-8 text-[var(--text-primary)] md:px-8">
          <WhatsAppAuthShell
            autoStart
            currentPath={currentPath}
            initialPhone={sessionAccess.whatsappPhone}
            isPhoneLocked
            primaryButtonLabel="Send another code"
            title="Review your session"
          />
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-[var(--bg-main)] px-4 py-8 text-[var(--text-primary)] md:px-8">
        <WhatsAppAuthShell currentPath={currentPath} />
      </div>
    );
  }

  const profile = await getWhatsAppProfile(supabase, user);
  const displayPhone = profile.whatsappPhone ?? profile.authPhone ?? "Not linked";

  return (
    <div className="min-h-screen bg-[var(--bg-main)] text-[var(--text-primary)]">
      <header className="border-b border-[var(--border-color)] bg-[var(--bg-main)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 md:px-8">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--text-secondary)]">
              WhatsApp
            </div>
            <div className="mt-1 text-[22px] font-semibold">WhatsApp Dashboard</div>
          </div>

          <nav className="flex flex-wrap items-center justify-end gap-2">
            <Link
              href="/whatsapp"
              className="border border-[var(--border-color)] px-3 py-2 text-[13px] font-medium hover:border-[var(--text-primary)]"
            >
              Home
            </Link>
            <Link
              href="/whatsapp/account"
              className="border border-[var(--border-color)] px-3 py-2 text-[13px] font-medium hover:border-[var(--text-primary)]"
            >
              Account
            </Link>
            <Link
              href="/whatsapp/connectors/overview"
              className="border border-[var(--border-color)] px-3 py-2 text-[13px] font-medium hover:border-[var(--text-primary)]"
            >
              Overview
            </Link>
            <Link
              href="/whatsapp/settings/voice"
              className="border border-[var(--border-color)] px-3 py-2 text-[13px] font-medium hover:border-[var(--text-primary)]"
            >
              Voice
            </Link>
            {connectorDefinitions.map((definition) => (
              <Link
                key={definition.toolkit}
                href={`/whatsapp/connectors/${definition.routeSegment}`}
                className="border border-[var(--border-color)] px-3 py-2 text-[13px] font-medium hover:border-[var(--text-primary)]"
              >
                {definition.label}
              </Link>
            ))}
            <WhatsAppSignOutButton />
          </nav>
        </div>

        <div className="mx-auto max-w-5xl px-4 pb-4 text-[13px] text-[var(--text-secondary)] md:px-8">
          Signed in with <span className="font-medium text-[var(--text-primary)]">{displayPhone}</span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 md:px-8">
        {children}
      </main>
    </div>
  );
}
