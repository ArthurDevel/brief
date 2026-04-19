export const DASHBOARD_ERROR_MESSAGES = {
  UNAUTHORIZED: "Your session expired. Please sign in again.",
  NETWORK_ERROR: "We couldn't reach the server. Please check your connection and try again.",
  UNKNOWN_ERROR: "Something went wrong. Please try again.",

  EMAIL_SETTINGS_LOAD_FAILED: "We couldn't load your email settings. Please refresh and try again.",
  EMAIL_CONNECT_FAILED: "We couldn't start the email connection flow. Please try again.",
  EMAIL_INBOX_CONNECT_FAILED: "We couldn't connect to your inbox. Please check your settings.",
  EMAIL_SMTP_CONNECT_FAILED: "We couldn't send email from this account. Double-check your outgoing mail settings.",
  EMAIL_RECONNECT_REQUIRED: "This email account needs to be reconnected.",
  EMAIL_ACCOUNT_REQUIRED: "Connect your email account in Settings to continue.",
  EMAIL_SAVE_FAILED: "We couldn't save your email settings. Please try again.",
  EMAIL_PASSWORDS_REQUIRED: "Please enter both your IMAP and SMTP passwords.",
  EMAIL_INBOX_VERIFY_FAILED: "Your settings were saved, but we couldn't verify your inbox connection. Please double-check your credentials.",
  EMAIL_SMTP_VERIFY_FAILED: "Your settings were saved, but we couldn't verify sending email. Please double-check your outgoing mail settings.",
  EMAIL_VERIFY_FAILED: "Your settings were saved, but we couldn't verify your email connection. Please double-check your credentials.",

  CALL_SETTINGS_LOAD_FAILED: "We couldn't load your call settings. Please refresh and try again.",
  CALL_START_FAILED: "We couldn't start your call. Please try again.",
  CALL_CONNECT_FAILED: "We couldn't connect your call. Please check your internet connection and try again.",
  MIC_PERMISSION_DENIED: "We couldn't access your microphone. Please check your browser permissions.",
  PHONE_REQUIRED: "Add your phone number in Settings to receive calls.",
  COUNTRY_NOT_SUPPORTED: "Calls aren't available in your country yet.",
  USAGE_LIMIT_REACHED: "You've reached your monthly call limit. Upgrade to keep calling.",
  CALL_TRIGGER_FAILED: "We couldn't call your phone right now. Please try again.",

  ACTION_LOAD_FAILED: "We couldn't load your actions. Please refresh and try again.",
  ACTION_APPROVE_FAILED: "We couldn't approve that action. Please try again.",
  ACTION_REJECT_FAILED: "We couldn't reject that action. Please try again.",
  ACTION_NOT_FOUND: "That action is no longer available.",
  ACTION_ALREADY_HANDLED: "That action has already been handled.",
  ACTION_EXECUTION_FAILED: "We couldn't complete that email action. Please check your email settings and try again.",
  ACTION_UNDO_FAILED: "We couldn't undo that action. Please try again.",
  ACTION_DRAFT_FAILED: "We couldn't save this email as a draft. Please try again.",
  ACTION_EMAIL_MISSING: "We couldn't find that email anymore.",
  ACTION_FOLDER_MISSING: "That folder is no longer available.",
  BULK_ACTION_PARTIAL_FAILURE: "Some actions couldn't be completed. Please review them and try again.",
  BULK_ACTION_FAILED: "Some actions couldn't be completed. Please review them and try again.",

  SESSION_LOAD_FAILED: "We couldn't load this session. Please refresh and try again.",
  SESSION_NOT_FOUND: "This session could not be found.",
  SESSION_HISTORY_LOAD_FAILED: "We couldn't load your session history. Please refresh and try again.",

  SETTINGS_LOAD_FAILED: "We couldn't load your settings. Please refresh and try again.",
  SETTINGS_SAVE_FAILED: "We couldn't save your settings. Please try again.",
  VOICE_LOAD_FAILED: "We couldn't load available voices. Please refresh and try again.",
  MEMORY_LOAD_FAILED: "We couldn't load your saved notes. Please refresh and try again.",
  COMPANY_PHONES_LOAD_FAILED: "We couldn't load supported phone numbers. Please refresh and try again.",
  PHONE_INVALID: "Enter a valid phone number in international format.",
  PHONE_COUNTRY_MISMATCH: "That phone number doesn't match the selected country.",
  PHONE_ALREADY_IN_USE: "This phone number is already used by another account. Please use another number.",
  PHONE_SAVE_FAILED: "We couldn't save your phone number. Please try again.",
  PIN_SAVE_FAILED: "We couldn't save your PIN. Please try again.",
  MEMORY_CREATE_FAILED: "We couldn't save that note. Please try again.",
  MEMORY_DELETE_FAILED: "We couldn't delete that note. Please try again.",

  SCHEDULE_LOAD_FAILED: "We couldn't load your schedule. Please refresh and try again.",
  SCHEDULE_SAVE_FAILED: "We couldn't save your schedule. Please try again.",

  BILLING_LOAD_FAILED: "We couldn't load your billing information. Please refresh and try again.",
  UPGRADE_FAILED: "We couldn't upgrade your plan right now. Please try again.",

  FEATURE_REQUEST_LOAD_FAILED: "We couldn't load your feature requests. Please refresh and try again.",
  FEATURE_REQUEST_EMPTY: "Enter a feature request before submitting.",
  FEATURE_REQUEST_SUBMIT_FAILED: "We couldn't submit your feature request. Please try again.",
} as const;

export type DashboardErrorCode = keyof typeof DASHBOARD_ERROR_MESSAGES;

export const DEFAULT_USER_ERROR =
  DASHBOARD_ERROR_MESSAGES.UNKNOWN_ERROR;

export function isDashboardErrorCode(value: string): value is DashboardErrorCode {
  return value in DASHBOARD_ERROR_MESSAGES;
}

export function getDashboardErrorMessage(code: DashboardErrorCode): string {
  return DASHBOARD_ERROR_MESSAGES[code];
}
