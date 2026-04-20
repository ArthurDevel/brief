import Link from "next/link";

export default function WhatsAppPage() {
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

        <Link
          href="/whatsapp/connectors/gmail"
          className="settings-panel block transition hover:border-[var(--text-primary)]"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Gmail
          </div>
          <h2 className="mt-2 text-[20px] font-semibold">Connect Gmail</h2>
          <p className="mt-2 text-[14px] leading-6 text-[var(--text-secondary)]">
            Start the WhatsApp-scoped Gmail auth flow that stores a user-specific Composio connection.
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
