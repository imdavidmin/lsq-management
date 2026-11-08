# Authentication & Sessions

Decision record for how users log in and stay logged in. See also D17 in
`docs/decisions.md`.

## Context that drives the design

- **Closed, board-provisioned user base** — ~200 units of known residents tied
  to units, plus a handful of staff/board. No public signup.
- **Low daily active users** — realistically tens of logins per day, not
  thousands. Every request already loads the user's `accounts` row for
  role/scope (UJ-09), so the app is **DB-bound per request either way**.
- **Email is already the identity anchor** (the CC-update flow keys off it).
- **Board-owned, zero-cost-to-run** — avoid per-seat auth vendors and extra
  GDPR data processors where a small amount of our own code suffices.

These four together rule out both heavyweight auth vendors and stateless-JWT
refresh-token schemes (see rejected options).

## Decision

**Passwordless email OTP + server-side sliding session.** Self-hosted on
Cloudflare Workers + D1. Permissions are _not_ an auth-provider concern — they
are scoped RBAC (`roles` + `role_permissions` + `grants`) enforced in the Worker
(D18).

### Login (OTP)

1. User enters email → Worker checks it exists in `accounts` and `active=1`.
   No match → respond identically (no account enumeration).
2. Worker generates a **6-digit code**, stores it **hashed** in `otp_codes`
   with a ~10 min `expires_at`, and emails it (MailerSend).
3. User enters the code → Worker verifies against the hash, checks TTL and
   attempt count, then **consumes** it (single use).
4. On success → create a session (below) and set the cookie.

### Session (long-lived, renewable, revocable)

- On login, create one `sessions` row: random 256-bit token stored **hashed**,
  a sliding `expires_at` (e.g. +30 days) and an absolute `hard_expires_at` cap
  (e.g. +90 days).
- Token is delivered in an **httpOnly, Secure, SameSite=Lax** cookie.
- **Every request:** hash the cookie → look up the session (same round-trip that
  loads the account) → if valid, **slide `expires_at` forward** up to
  `hard_expires_at`. This is the "renewal" — automatic, no separate refresh
  endpoint or refresh token.
- **Logout / revocation:** delete the session row(s). `accounts.active=0` also
  logs the user out on next request. Real, immediate revocation.

### Non-negotiable security controls

- OTP: hashed at rest, ~10 min TTL, single-use, **max ~5 attempts** then
  invalidate.
- **Rate-limit** OTP request (per IP + per email) and verify (per IP) via the
  Cloudflare Workers native rate-limiting binding `OTP_LIMIT` — not a DB counter,
  which wouldn't cap Worker invocations. See [security.md](security.md).
- Session token: 256-bit random, hashed at rest, httpOnly + Secure + SameSite.
- No account enumeration on the email-entry step.

## Email sending

- **MailerSend** free tier for now (OTP, chases, reports, notifications — one
  shared transactional sender). Upgrade tier or swap provider later; it's one
  module.
- **Setup (done):** the domain is verified in MailerSend. SPF, DKIM
  (`ms1._domainkey`), return-path (`mta`) and DMARC are live; see
  `architecture.md` → *Domain & mail DNS*. Mail goes from
  `MAIL_FROM_NAME <MAIL_FROM>` (`Lansbury Square <ops@…>`). `ops@` has no
  alias, so replies bounce; it's a no-reply sender until the board adds one (D26).
- **Key:** a send-only API token, stored as the `MAILERSEND_API_KEY` Worker
  secret and kept locally in `.env` (gitignored). Without it (`wrangler dev`
  with a `.dev.vars`, tests) `sendMail` logs the mail instead of sending.
- `sendMail` never throws: a MailerSend failure is logged, so
  `/auth/otp/request` stays always-204 (no enumeration).
- Free tier has a monthly send cap and, while the account is unapproved, a
  recipient restriction. That's fine at ~200 units; watch it if notifications
  grow.

## Rejected alternatives

- **Auth0 / Firebase** — built for public signup / social / enterprise SSO we
  don't need; capped free tiers that get costly; extra external data processor.
- **Cloudflare Access (Zero Trust)** — edge/WAF-level perimeter auth, not
  in-app; gives identity but not our role/scope model; free only to 50 users.
  Wrong tool for 200+ residents.
- **Stateless JWT with refresh-token rotation** — refresh tokens exist to avoid
  a DB hit per request; we hit D1 every request anyway for role/scope, so the
  rotation + reuse-detection machinery buys nothing and can't revoke cleanly.
- **Clerk / Stytch** — viable managed fallback (magic-link/OTP + React
  components) if we later decide not to own token security; costs one vendor +
  one GDPR processor. Not chosen while the board owns and maintains the system.
