export default function WhatsAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-screen overflow-y-auto bg-[var(--bg-main)]">
      {children}
    </div>
  );
}
