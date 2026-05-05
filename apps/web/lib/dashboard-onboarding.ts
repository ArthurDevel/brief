import type { EmailStatus } from "@/lib/email-status-cache";
import type { UserSettings } from "@/lib/types";

export interface DashboardOnboardingStep {
  id: "email";
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
        description: "Connected and ready for inbox access during sessions",
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
        description: "Fix your inbox connection so OpenPokeButVoice can process email",
        href: "/dashboard/settings?tab=email",
        primaryLabel: "Fix inbox",
      };
    case "pending":
    case "not_configured":
    default:
      return {
        complete: false,
        description: "Required so OpenPokeButVoice can read and act on email",
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

  const steps: DashboardOnboardingStep[] = [
    {
      id: "email",
      title: "Connect your inbox",
      description: emailStep.description,
      href: emailStep.href,
      complete: emailStep.complete,
    },
  ];

  const requiredSteps = steps.filter((step) => !step.optional);
  const requiredCompleted = requiredSteps.filter((step) => step.complete).length;
  const firstIncompleteRequired = requiredSteps.find((step) => !step.complete);

  let primaryHref = "/dashboard/settings";
  let primaryLabel = "Open settings";

  if (firstIncompleteRequired) {
    primaryHref = firstIncompleteRequired.href;
    primaryLabel = emailStep.primaryLabel;
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
