# Security Posture

Cross-cutting security controls for the LSQ Site Operations backend. This is the
consolidated view; the deep rationale lives in [authentication.md](authentication.md)
and [decisions.md](decisions.md) (D17 auth, D18 RBAC). Context: low daily user
count, ~200 units, sensitive personal data, board-owned system.

## Authentication (D17)

- Passwordless email OTP. 6-digit code, **hashed at rest**, ~10 min TTL,
  single-use, **max 5 attempts** then burned.
- No account enumeration: `/auth/otp/request` always returns 204.
- Sessions: opaque 256-bit random token, **SHA-256 hashed at rest**, server-side
  row in `sessions`. Sliding `expires_at` (30d) capped by `hard_expires_at` (90d).
  Revoke = delete the row (immediate).

## Session cookie

- `httpOnly` + `Secure` + `SameSite=Lax`, name `session`. No token or PII in the
  cookie beyond the random session id.

## Rate limiting

Enforced by the **Cloudflare Workers native rate-limiting binding** `OTP_LIMIT`
(`wrangler.jsonc` → `unsafe.bindings`), not a DB counter — a DB counter runs
_after_ the Worker is invoked and can't cap invocation cost.

| Endpoint                        | Keys                           | Policy    |
| ------------------------------- | ------------------------------ | --------- |
| `POST /auth/otp/request`        | `ip:<addr>` AND `mail:<email>` | 10 / 60s  |
| `POST /auth/otp/verify`         | `vrf:<addr>`                   | 10 / 60s  |
| **all endpoints** (`API_LIMIT`) | `api:<addr>`                   | 300 / 60s |

- The lax global `API_LIMIT` (app-wide middleware) is a **billing/DoS backstop**:
  even when info and system are safe, it caps how fast one source can rack up
  Worker invocations. The tight OTP limits stack on top for the auth endpoints.
- Over-limit request → silent 204 (indistinguishable from normal, no enumeration).
- Over-limit verify / any endpoint over the global cap → 429.
- Wrapper: [`server/src/lib/ratelimit.ts`](../server/src/lib/ratelimit.ts). Absent binding →
  allow (so Vitest / `wrangler dev` need no config).

**Deploy tasks (dashboard, not code):**

- Add the **free WAF rate-limiting rule** on `/auth/otp/*` per IP — this is the
  edge-level stop for raw invocation floods the in-Worker binding can't prevent.
- `OTP_LIMIT` `namespace_id` (`1001`) must stay unique across any future limiters.

## Authorization (D18)

Scoped RBAC: `roles` + `role_permissions` + `grants`. Every protected route runs
`session` middleware then `requirePermission(perm, scopeResolver)`, resolving the
target's scope chain (estate ⊇ building ⊇ unit ⊇ ticket) against the caller's
grants. Accounts are identity-only; all access flows through grants.

## Transport & secrets

- HTTPS only (Cloudflare edge). `Secure` cookies assume TLS.
- Secrets via `wrangler secret`, never in `wrangler.jsonc` `vars` or the repo:
  - `MAILERSEND_API_KEY`: a send-only MailerSend token.
  - `CF_EMAIL_TOKEN`: an account-owned Cloudflare API token. The server only
    needs Account › Email Routing Addresses:Edit (to register alias
    destinations). The token also has Zone › Email Routing Rules:Edit for
    `lansburysquare.co.uk`, which the app doesn't use and which can be dropped.
- Email attachments are untrusted files served from our origin (D28). They are
  always sent with `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox`, and only PNG/JPEG/GIF/WebP/PDF render
  inline. Everything else, including HTML, SVG and the original `.eml`,
  downloads as `application/octet-stream`. Access is gated by the ticket's
  `ticket:read` scope.
- SPF, DKIM and DMARC are live on `lansburysquare.co.uk`. Records are in
  `architecture.md` → *Domain & mail DNS*.
- Main-domain forward addresses can be changed by board/admin only
  (`mail:manage`). The agent can't re-point `board@` (D26). Changes are audited
  on `events`.

## Audit

Append-only `events` spine (D7): security-relevant state changes are recorded,
never mutated in place.

## GDPR

Sensitive personal data drives the granular RBAC scope model (D18). Documented,
not re-architected (D12).

## Known ceilings / not done

- No distributed-mailbomb defence beyond the per-email 10/60 cap — add a tighter
  per-email limiter only if abused.
- No CAPTCHA. **Turnstile** (free) on the login form is the fallback if bot
  OTP-spam appears.
- No per-request CSRF token; `SameSite=Lax` + JSON-only bodies cover the current
  surface. Revisit if any state-changing endpoint accepts form posts.
