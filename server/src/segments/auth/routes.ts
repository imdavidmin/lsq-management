import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../env";
import { body } from "../../lib/validate";
import { rateLimit } from "../../lib/ratelimit";
import { rateLimited, unauthorized } from "../../lib/errors";
import { OTP_REGEX } from "../../../../common/auth";
import {
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from "../../lib/cookies";
import { requireSession } from "../../middleware/session";
import { grantsForAccount } from "../../db/client";
import { destroySession, permissionsFor, requestOtp, verifyOtp } from "./service";

const requestSchema = z.object({ email: z.string().email() });
const verifySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(OTP_REGEX),
});

export const auth = new Hono<AppContext>();

// POST /auth/otp/request — always 204 (no account enumeration).
auth.post("/otp/request", async (c) => {
  const { email } = await body(c, requestSchema);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  // Per-IP (flood/cost) and per-email (mailbomb) caps. Silently drop when over —
  // still 204 so a rate-limited request looks identical to a normal one.
  const ok =
    (await rateLimit(c.env.OTP_LIMIT, `ip:${ip}`)) &&
    (await rateLimit(c.env.OTP_LIMIT, `mail:${email.toLowerCase()}`));
  if (ok) await requestOtp(c.env, email);
  return c.body(null, 204);
});

// POST /auth/otp/verify — verify code, open a session.
auth.post("/otp/verify", async (c) => {
  const { email, code } = await body(c, verifySchema);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await rateLimit(c.env.OTP_LIMIT, `vrf:${ip}`))) rateLimited("too many attempts");
  const session = await verifyOtp(c.env, email, code);
  if (!session) unauthorized("invalid or expired code");
  setSessionCookie(c, session!.token, session!.maxAgeSec);
  const grants = await grantsForAccount(c.env.DB, session!.account.id);
  return c.json({
    account: session!.account,
    grants,
    permissions: await permissionsFor(c.env, session!.account.id),
  });
});

// POST /auth/logout — delete current session.
auth.post("/logout", async (c) => {
  const token = readSessionCookie(c);
  if (token) await destroySession(c.env, token);
  clearSessionCookie(c);
  return c.body(null, 204);
});

// GET /auth/me — current identity + grants + effective permissions.
auth.get("/me", requireSession, async (c) => {
  const account = c.get("account");
  return c.json({
    account,
    grants: c.get("grants"),
    permissions: await permissionsFor(c.env, account.id),
  });
});
