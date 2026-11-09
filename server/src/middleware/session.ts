import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../env";
import { one, run, grantsForAccount } from "../db/client";
import type { Account } from "../db/client";
import { readSessionCookie } from "../lib/cookies";
import { sha256hex } from "../lib/crypto";
import { unauthorized } from "../lib/errors";

const SLIDE_DAYS = 30;

// Loads the session → account + grants; slides expiry; rejects if
// missing/expired/inactive. Sets c.var.account and c.var.grants.
export const requireSession: MiddlewareHandler<AppContext> = async (c, next) => {
  const token = readSessionCookie(c);
  if (!token) unauthorized("no session");

  const now = new Date().toISOString();
  const tokenHash = await sha256hex(token!);
  const session = await one<{ id: number; account_id: number; hard_expires_at: string }>(
    c.env.DB,
    `SELECT id, account_id, hard_expires_at FROM sessions
       WHERE token_hash = ? AND expires_at > ? AND hard_expires_at > ?`,
    tokenHash,
    now,
    now
  );
  if (!session) unauthorized("session expired");

  const account = await one<Account>(
    c.env.DB,
    "SELECT id, email, name, active FROM accounts WHERE id = ? AND active = 1",
    session!.account_id
  );
  if (!account) unauthorized("account inactive");

  // Slide expires_at forward, capped at hard_expires_at.
  const slid = new Date(Date.now() + SLIDE_DAYS * 86_400_000).toISOString();
  const newExpiry = slid < session!.hard_expires_at ? slid : session!.hard_expires_at;
  await run(
    c.env.DB,
    "UPDATE sessions SET expires_at = ?, last_used_at = ? WHERE id = ?",
    newExpiry,
    now,
    session!.id
  );

  const grants = await grantsForAccount(c.env.DB, account!.id);

  c.set("account", account!);
  c.set("grants", grants);
  await next();
};

