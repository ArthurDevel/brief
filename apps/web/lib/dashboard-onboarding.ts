import type { EmailStatus } from "@/lib/email-status-cache";
import type { CallSchedule, UserSettings } from "@/lib/types";

export interface DashboardOnboardingStep {
  id: "phone" | "email" | "pin" | "schedule";
  title: string;
  description: string;
  href: string;
  complete: boolean;
  optional?: boolean;
}

export interface DashboardOnboardingState {
  isComplete: boolean;
  requiredCompleted: number;
  requiredTotal: number;
  steps: DashboardOnboardingStep[];
  primaryHref: string;
  primaryLabel: string;
}

const SCHEDULE_DAY_KEYS: Array<keyof CallSchedule> = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

function hasConfiguredSchedule(schedule: CallSchedule | null): boolean {
  if (!schedule) {
    return false;
  }

  return SCHEDULE_DAY_KEYS.some((day) => {
    const value = schedule[day];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function resolveEmailStep(
  settings: UserSettings,
  emailStatus?: EmailStatus | null
): Pick<DashboardOnboardingStep, "complete" | "description" | "href"> & {
  primaryLabel: string;
} {
  const status = emailStatus ?? settings.emailAccount?.status ?? "not_configured";

  switch (status) {
    case "connected":
      return {
        complete: true,
        description: "Connected and ready for inbox access during calls",
        href: "/dashboard/settings?tab=email",
        primaryLabel: "Open settings",
      };
    case "reconnect_required":
      return {
        complete: false,
        description: "Reconnect your inbox to restore email access",
        href: "/dashboard/settings?tab=email",
        primaryLabel: "Reconnect inbox",
      };
    case "error":
      return {
        complete: false,
        description: "Fix your inbox connection so BrewDock can process email",
        href: "/dashboard/settings?tab=email",
        primaryLabel: "Fix inbox",
      };
    case "pending":
    case "not_configured":
    default:
      return {
        complete: false,
        description: "Required so BrewDock can read and act on email",
        href: "/dashboard/settings?tab=email",
        primaryLabel: "Connect inbox",
      };
  }
}

export function getDashboardOnboardingState(
  settings: UserSettings,
  emailStatus?: EmailStatus | null
): DashboardOnboardingState {
  const emailStep = resolveEmailStep(settings, emailStatus);
  const hasSchedule = hasConfiguredSchedule(settings.callSchedule);

  const steps: DashboardOnboardingStep[] = [
    {
      id: "phone",
      title: "Add your phone number",
      description: settings.phone
        ? "Added and ready for caller verification"
        : "Required for calling and caller verification",
      href: "/dashboard/settings?tab=general",
      complete: settings.phone !== null,
    },
    {
      id: "email",
      title: "Connect your inbox",
      description: emailStep.description,
      href: emailStep.href,
      complete: emailStep.complete,
    },
    {
      id: "pin",
      title: "Set your security PIN",
      description: settings.hasPin
        ? "Set and ready for secure call sign-in"
        : "Required to verify your identity when you call",
      href: "/dashboard/settings?tab=general",
      complete: settings.hasPin,
    },
    {
      id: "schedule",
      title: "Pick a daily call time",
      description: hasSchedule
        ? "Optional schedule is configured"
        : "Optional if you want BrewDock to ring you automatically",
      href: "/dashboard/settings?tab=schedule",
      complete: hasSchedule,
      optional: true,
    },
  ];

  const requiredSteps = steps.filter((step) => !step.optional);
  const requiredCompleted = requiredSteps.filter((step) => step.complete).length;
  const firstIncompleteRequired = requiredSteps.find((step) => !step.complete);

  let primaryHref = "/dashboard/settings";
  let primaryLabel = "Open settings";

  if (firstIncompleteRequired) {
    primaryHref = firstIncompleteRequired.href;
    primaryLabel =
      firstIncompleteRequired.id === "phone"
        ? "Add phone number"
        : firstIncompleteRequired.id === "email"
          ? emailStep.primaryLabel
          : "Set security PIN";
  }

  return {
    isComplete: requiredCompleted === requiredSteps.length,
    requiredCompleted,
    requiredTotal: requiredSteps.length,
    steps,
    primaryHref,
    primaryLabel,
  };
}
