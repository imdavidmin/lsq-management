import type { Env } from "../../env";
import { all, one, run } from "../../db/client";
import type { Account } from "../../db/client";
import { otpCode, randomToken, sha256hex } from "../../lib/crypto";
import { sendMail } from "./mailer";

const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_SLIDE_DAYS = 30;
const SESSION_HARD_DAYS = 90;

const iso = (ms: number) => new Date(ms).toISOString();

async function activeAccountByEmail(env: Env, email: string): Promise<Account | null> {
  return one<Account>(
    env.DB,
    "SELECT id, email, name, active FROM accounts WHERE email = ? AND active = 1",
    email.toLowerCase()
  );
}

// UJ/D17: always returns void; never reveals whether the email exists.
export async function requestOtp(env: Env, email: string): Promise<void> {
  const account = await activeAccountByEmail(env, email);
  if (!account) return;
  // Request-rate limiting lives at the route (OTP_LIMIT binding), before this runs.

  const now = Date.now();
  const code = otpCode();
  await run(
    env.DB,
    `INSERT INTO otp_codes (account_id, code_hash, expires_at, attempts, created_at)
       VALUES (?, ?, ?, 0, ?)`,
    account.id,
    await sha256hex(code),
    iso(now + OTP_TTL_MIN * 60_000),
    iso(now)
  );
  await sendMail(env, {
    to: account.email,
    subject: "Your LSQ login code",
    text: `Your login code is ${code}. It expires in ${OTP_TTL_MIN} minutes.`,
  });
}

export interface VerifiedSession {
  account: Account;
  token: string;
  maxAgeSec: number;
}

// Returns null on any failure (invalid/expired/used code, too many attempts).
export async function verifyOtp(
  env: Env,
  email: string,
  code: string
): Promise<VerifiedSession | null> {
  const account = await activeAccountByEmail(env, email);
  if (!account) return null;

  const now = Date.now();
  const otp = await one<{ id: number; code_hash: string; attempts: number }>(
    env.DB,
    `SELECT id, code_hash, attempts FROM otp_codes
       WHERE account_id = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    account.id,
    iso(now)
  );
  if (!otp) return null;

  if (otp.attempts + 1 >= OTP_MAX_ATTEMPTS) {
    // Burn it on the last allowed attempt regardless of correctness.
    await run(env.DB, "UPDATE otp_codes SET consumed_at = ? WHERE id = ?", iso(now), otp.id);
  } else {
    await run(env.DB, "UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?", otp.id);
  }

  if ((await sha256hex(code)) !== otp.code_hash) return null;

  await run(env.DB, "UPDATE otp_codes SET consumed_at = ? WHERE id = ?", iso(now), otp.id);
  return createSession(env, account, now);
}

async function createSession(env: Env, account: Account, now: number): Promise<VerifiedSession> {
  const token = randomToken();
  await run(
    env.DB,
    `INSERT INTO sessions (account_id, token_hash, created_at, last_used_at, expires_at, hard_expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    account.id,
    await sha256hex(token),
    iso(now),
    iso(now),
    iso(now + SESSION_SLIDE_DAYS * 86_400_000),
    iso(now + SESSION_HARD_DAYS * 86_400_000)
  );
  return { account, token, maxAgeSec: SESSION_SLIDE_DAYS * 86_400 };
}

export async function destroySession(env: Env, token: string): Promise<void> {
  await run(env.DB, "DELETE FROM sessions WHERE token_hash = ?", await sha256hex(token));
}

// Flattened unique permission strings across the account's roles (for the UI).
export async function permissionsFor(env: Env, accountId: number): Promise<string[]> {
  const rows = await all<{ permission: string }>(
    env.DB,
    `SELECT DISTINCT rp.permission FROM role_permissions rp
       JOIN grants g ON g.role_key = rp.role_key
      WHERE g.account_id = ?`,
    accountId
  );
  return rows.map((r) => r.permission).sort();
}
