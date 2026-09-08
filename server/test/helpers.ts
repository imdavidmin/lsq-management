import { env } from "cloudflare:test";
import { randomToken, sha256hex } from "../src/lib/crypto";

type Scope = "estate" | "building" | "unit" | "organization" | "ticket";

export async function seedAccount(email: string, name = email): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO accounts (email, name, active) VALUES (?, ?, 1)"
  )
    .bind(email.toLowerCase(), name)
    .run();
  return res.meta.last_row_id as number;
}

export async function addGrant(
  accountId: number,
  role: string,
  scopeType: Scope,
  scopeId: number | null
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO grants (account_id, role_key, scope_type, scope_id) VALUES (?, ?, ?, ?)"
  )
    .bind(accountId, role, scopeType, scopeId)
    .run();
}

// Seed an OTP row with a known plaintext code (bypasses email in tests).
export async function seedOtp(accountId: number, code: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO otp_codes (account_id, code_hash, expires_at, attempts, created_at)
       VALUES (?, ?, ?, 0, ?)`
  )
    .bind(
      accountId,
      await sha256hex(code),
      new Date(now + 10 * 60_000).toISOString(),
      new Date(now).toISOString()
    )
    .run();
}

// Seed an account + grant + a live session directly, returning a reusable
// cookie. Bypasses the OTP-verify route so tests aren't subject to its
// (per-IP) rate limit — auth flow itself is covered in auth.test.ts.
export async function login(
  email: string,
  role: string,
  scopeType: Scope,
  scopeId: number | null
): Promise<{ id: number; cookie: string }> {
  const id = await seedAccount(email);
  await addGrant(id, role, scopeType, scopeId);
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (account_id, token_hash, created_at, last_used_at, expires_at, hard_expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      await sha256hex(token),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      new Date(now + 30 * 86_400_000).toISOString(),
      new Date(now + 90 * 86_400_000).toISOString()
    )
    .run();
  return { id, cookie: `session=${token}` };
}

// Extract the `session=...` pair from a Set-Cookie header for reuse.
export function sessionCookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const m = raw.match(/session=[^;]+/);
  if (!m) throw new Error("no session cookie set");
  return m[0];
}
