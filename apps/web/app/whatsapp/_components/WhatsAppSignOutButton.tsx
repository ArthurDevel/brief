"use client";

import { useRouter } from "next/navigation";

export default function WhatsAppSignOutButton() {
  const router = useRouter();

  async function handleClick(): Promise<void> {
    await fetch("/api/whatsapp/auth/logout", {
      method: "POST",
    });

    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      className="border border-[var(--border-color)] px-3 py-2 text-[13px] font-medium text-[var(--text-primary)] hover:border-[var(--text-primary)]"
    >
      Log out
    </button>
  );
}
