import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/app";

const SECRET = "whsec_test";
const testEnv = { ...env, MAILERSEND_WEBHOOK_SECRET: SECRET };

async function sign(body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const post = (body: string, signature?: string) =>
  app.request(
    "/api/webhooks/mailersend",
    { method: "POST", headers: { "content-type": "application/json", ...(signature ? { signature } : {}) }, body },
    testEnv
  );

const bounce = JSON.stringify({
  type: "activity.hard_bounced",
  data: { recipient: "dead@example.com", subject: "123456 is your code", meta: { bounce_reason: "No such user" } },
});

afterEach(() => vi.restoreAllMocks());

describe("mailersend webhook", () => {
  it("logs a signed hard bounce as an error (Sentry alert)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(bounce, await sign(bounce));
    expect(res.status).toBe(204);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/hard_bounced to=dead@example\.com .*No such user/));
  });

  it("logs a suppressed send with its reason", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = JSON.stringify({ type: "activity.suppressed", data: { recipient: "dead@example.com", meta: { suppression_reason: "hard_bounced" } } });
    expect((await post(body, await sign(body))).status).toBe(204);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/suppressed to=dead@example\.com .*reason=hard_bounced/));
  });

  it("rejects a missing or wrong signature without logging", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post(bounce)).status).toBe(401);
    expect((await post(bounce, await sign(bounce, "other"))).status).toBe(401);
    expect(err).not.toHaveBeenCalled();
  });

  it("acks the save-time ping and ignores routine events", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post(JSON.stringify({ type: "webhook.test" }))).status).toBe(204);
    const delivered = JSON.stringify({ type: "activity.delivered", data: { recipient: "a@b.com" } });
    expect((await post(delivered, await sign(delivered))).status).toBe(204);
    expect(err).not.toHaveBeenCalled();
  });
});
