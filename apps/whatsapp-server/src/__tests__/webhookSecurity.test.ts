import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  getMetaAppSecret,
  isJsonContentType,
  isValidMetaWebhookSignature,
} from "../webhookSecurity.js";

describe("getMetaAppSecret", () => {
  afterEach(() => {
    delete process.env.META_APP_SECRET;
  });

  it("returns the configured app secret", () => {
    process.env.META_APP_SECRET = "test-secret";

    expect(getMetaAppSecret()).toBe("test-secret");
  });

  it("throws when the app secret is missing", () => {
    expect(() => getMetaAppSecret()).toThrow(
      "META_APP_SECRET environment variable is required for WhatsApp webhooks"
    );
  });
});

describe("isJsonContentType", () => {
  it("accepts application/json", () => {
    expect(isJsonContentType("application/json")).toBe(true);
  });

  it("accepts application/json with charset", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
  });

  it("rejects other content types", () => {
    expect(isJsonContentType("multipart/form-data")).toBe(false);
  });
});

describe("isValidMetaWebhookSignature", () => {
  it("returns true for a valid signature", () => {
    const rawBody = Buffer.from('{"entry":[]}', "utf8");
    const appSecret = "test-secret";
    const digest = createHmac("sha256", appSecret).update(rawBody).digest("hex");

    expect(
      isValidMetaWebhookSignature(rawBody, `sha256=${digest}`, appSecret)
    ).toBe(true);
  });

  it("returns false for a missing signature", () => {
    const rawBody = Buffer.from("{}", "utf8");

    expect(isValidMetaWebhookSignature(rawBody, undefined, "test-secret")).toBe(false);
  });

  it("returns false for an invalid signature", () => {
    const rawBody = Buffer.from("{}", "utf8");

    expect(
      isValidMetaWebhookSignature(rawBody, "sha256=invalid-signature", "test-secret")
    ).toBe(false);
  });
});
