const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

export function isAdminUserId(userId: string | null | undefined): boolean {
  return typeof userId === "string" && ADMIN_USER_IDS.includes(userId);
}

export function getDefaultAdminUserId(): string | null {
  return ADMIN_USER_IDS[0] ?? null;
}
