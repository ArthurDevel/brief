import Link from "next/link";
import { listWhatsAppConnectorDefinitions } from "./connectors/connectorDefinitions";

export default function WhatsAppPage() {
  const connectorDefinitions = listWhatsAppConnectorDefinitions();

  return (
    <div className="grid gap-6">
      <section className="settings-panel">
        <h1>Open WhatsApp pages directly</h1>
        <p className="mt-2 text-[14px] leading-6 text-[var(--text-secondary)]">
          This surface handles its own login. If a user lands on any <code>/whatsapp/*</code> URL without a session,
          the page stays in place and shows the WhatsApp OTP gate inline.
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <Link
          href="/whatsapp/account"
          className="settings-panel block transition hover:border-[var(--text-primary)]"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Account
          </div>
          <h2 className="mt-2 text-[20px] font-semibold">View linked WhatsApp access</h2>
          <p className="mt-2 text-[14px] leading-6 text-[var(--text-secondary)]">
            Inspect the authenticated Supabase user and the WhatsApp-specific phone field.
          </p>
        </Link>

        {connectorDefinitions.map((definition) => (
          <Link
            key={definition.toolkit}
            href={`/whatsapp/connectors/${definition.routeSegment}`}
            className="settings-panel block transition hover:border-[var(--text-primary)]"
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              {definition.label}
            </div>
            <h2 className="mt-2 text-[20px] font-semibold">
              Connect {definition.label}
            </h2>
            <p className="mt-2 text-[14px] leading-6 text-[var(--text-secondary)]">
              {definition.navDescription}
            </p>
          </Link>
        ))}

        <Link
          href="/whatsapp/connectors/overview"
          className="settings-panel block transition hover:border-[var(--text-primary)]"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Overview
          </div>
          <h2 className="mt-2 text-[20px] font-semibold">View connected tools</h2>
          <p className="mt-2 text-[14px] leading-6 text-[var(--text-secondary)]">
            See every saved connector for the signed-in WhatsApp user and whether it is currently connected.
          </p>
        </Link>

        <Link
          href="/whatsapp/settings/voice"
          className="settings-panel block transition hover:border-[var(--text-primary)]"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Voice
          </div>
          <h2 className="mt-2 text-[20px] font-semibold">Adjust WhatsApp voice</h2>
          <p className="mt-2 text-[14px] leading-6 text-[var(--text-secondary)]">
            Change the voice and speaking speed used by the WhatsApp agent during calls.
          </p>
        </Link>

        <div className="settings-panel">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Routing
          </div>
          <h2 className="mt-2 text-[20px] font-semibold">Path-preserving auth</h2>
          <p className="mt-2 text-[14px] leading-6 text-[var(--text-secondary)]">
            The login UI is scoped to this route tree and does not redirect through the main dashboard login.
          </p>
        </div>
      </section>
    </div>
  );
}
