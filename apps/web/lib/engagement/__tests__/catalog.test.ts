/**
 * Tests for the shared engagement email catalog.
 *
 * Verifies:
 * - email_verified is exposed in the admin label registry
 * - email_verified resolves the expected path label
 * - email_verified template content uses the dashboard CTA
 */

import { describe, expect, it } from "vitest";
import {
  EMAIL_TYPE_OPTIONS,
  getEmailPathLabel,
  getEmailTypeLabel,
  getEngagementEmailContent,
} from "../catalog";

// ============================================================================
// TESTS
// ============================================================================

describe("engagement catalog", () => {
  it("includes email_verified in the admin options", () => {
    expect(EMAIL_TYPE_OPTIONS.some((option) => option.value === "email_verified")).toBe(true);
    expect(getEmailTypeLabel("email_verified")).toBe("Email verified");
  });

  it("maps email_verified to the EV path label", () => {
    expect(getEmailPathLabel("email_verified")).toBe("EV");
  });

  it("returns the dashboard CTA for email_verified", () => {
    const content = getEngagementEmailContent(
      "email_verified",
      "https://lander.example.com",
      "https://app.example.com"
    );

    expect(content.subject).toBe("Your email is verified");
    expect(content.ctaText).toBe("Open dashboard");
    expect(content.ctaUrl).toBe("https://app.example.com/dashboard");
  });
});
