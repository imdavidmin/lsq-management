import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { app } from "../src/app";
import { addGrant, seedAccount, seedOtp, sessionCookie } from "./helpers";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("auth", () => {
  it("request → verify → me → logout", async () => {
    const id = await seedAccount("alice@lsq.test", "Alice");
    await addGrant(id, "resident", "unit", 101);

    // request always 204
    const reqRes = await app.request("/api/auth/otp/request", json({ email: "alice@lsq.test" }), env);
    expect(reqRes.status).toBe(204);

    // verify with a seeded known code
    await seedOtp(id, "123456");
    const verifyRes = await app.request(
      "/api/auth/otp/verify",
      json({ email: "alice@lsq.test", code: "123456" }),
      env
    );
    expect(verifyRes.status).toBe(200);
    const cookie = sessionCookie(verifyRes);
    const payload = (await verifyRes.json()) as any;
    expect(payload.account.email).toBe("alice@lsq.test");
    expect(payload.permissions).toContain("ticket:create");

    // me with cookie
    const meRes = await app.request("/api/auth/me", { headers: { cookie } }, env);
    expect(meRes.status).toBe(200);
    expect(((await meRes.json()) as any).account.id).toBe(id);

    // logout, then me is unauthorized
    const outRes = await app.request("/api/auth/logout", { method: "POST", headers: { cookie } }, env);
    expect(outRes.status).toBe(204);
    const meAfter = await app.request("/api/auth/me", { headers: { cookie } }, env);
    expect(meAfter.status).toBe(401);
  });

  it("rejects an expired/used code", async () => {
    const id = await seedAccount("bob@lsq.test", "Bob");
    await seedOtp(id, "654321");
    // first use consumes it
    await app.request("/api/auth/otp/verify", json({ email: "bob@lsq.test", code: "654321" }), env);
    // second use fails
    const res = await app.request(
      "/api/auth/otp/verify",
      json({ email: "bob@lsq.test", code: "654321" }),
      env
    );
    expect(res.status).toBe(401);
  });

  it("does not enumerate unknown emails", async () => {
    const res = await app.request(
      "/api/auth/otp/request",
      json({ email: "nobody@lsq.test" }),
      env
    );
    expect(res.status).toBe(204);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM otp_codes o JOIN accounts a ON a.id=o.account_id WHERE a.email=?"
    )
      .bind("nobody@lsq.test")
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("me requires a session", async () => {
    const res = await app.request("/api/auth/me", {}, env);
    expect(res.status).toBe(401);
  });
});
