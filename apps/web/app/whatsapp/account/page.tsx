import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { getWhatsAppProfile } from "@/lib/whatsapp-auth";

export default async function WhatsAppAccountPage() {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const profile = await getWhatsAppProfile(supabase, user);

  return (
    <section className="settings-panel">
      <h1>Account</h1>
      <div className="mt-6 grid gap-4 text-[14px]">
        <div>
          <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Auth user ID
          </div>
          <div className="mt-1 break-all">{user.id}</div>
        </div>

        <div>
          <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Supabase auth phone
          </div>
          <div className="mt-1">{profile.authPhone ?? "Not set"}</div>
        </div>

        <div>
          <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            WhatsApp phone field
          </div>
          <div className="mt-1">{profile.whatsappPhone ?? "Not set yet"}</div>
        </div>

        <div>
          <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Email
          </div>
          <div className="mt-1">{user.email ?? "No email on this account"}</div>
        </div>
      </div>
    </section>
  );
}
