export type WhatsAppRecipientOption = {
  label: string;
  value: string;
};

export type WhatsAppUiConfig = {
  fromNumber: string | null;
  phoneNumberId: string | null;
  businessAccountId: string | null;
  recipients: WhatsAppRecipientOption[];
};

export type WhatsAppServerConfig = WhatsAppUiConfig & {
  accessToken: string | null;
  webhookVerifyToken: string | null;
  apiVersion: string;
};

export function normalizePhoneNumber(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function parseRecipientOptions(raw: string | undefined): WhatsAppRecipientOption[] {
  if (!raw) return [];

  const seen = new Set<string>();
  const options: WhatsAppRecipientOption[] = [];

  for (const entry of raw.split(",")) {
    const label = entry.trim();
    if (!label) continue;

    const normalized = normalizePhoneNumber(label);
    if (!normalized || seen.has(normalized)) continue;

    seen.add(normalized);
    options.push({
      label,
      value: normalized,
    });
  }

  return options;
}

export function getWhatsAppConfig(): WhatsAppServerConfig {
  const recipients = parseRecipientOptions(process.env.WHATSAPP_TEST_RECIPIENTS);

  return {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? null,
    apiVersion: process.env.WHATSAPP_GRAPH_API_VERSION || "v23.0",
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? null,
    fromNumber: process.env.WHATSAPP_TEST_FROM_NUMBER ?? null,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? null,
    recipients,
    webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? null,
  };
}

export function getWhatsAppUiConfig(): WhatsAppUiConfig {
  const { fromNumber, phoneNumberId, businessAccountId, recipients } = getWhatsAppConfig();
  return {
    fromNumber,
    phoneNumberId,
    businessAccountId,
    recipients,
  };
}
