# Architecture & Technical Design

Companion to `migrations/0001_init.sql`. Covers the two moving parts that matter: the inbound
email flow and the nightly scoring/chase engine.

## Stack

- **Frontend** — Vite + React + TypeScript, **Fluent UI v9** (softened token
  theme), ag-grid for advanced tables.
- **Cloudflare Workers** — three deployed Workers sharing one D1: `server`
  (Hono API + cron), `email` (inbound `email()` → queue), `ai` (queue consumer:
  summarise + append events). See Inbound email flow for why three, not one.
- **D1 (SQLite)** — all persistent state (`migrations/0001_init.sql`), shared by all Workers.
- **Workers AI** — inbound email summarisation only (in the `ai` Worker).
  Ticket categories are chosen by the creator, not classified by AI.
- **Queues + R2** — inbound email is staged in R2 and processed off a queue by
  the `ai` Worker (see Inbound email flow).
- **Email Routing** — inbound catch-all → `email` Worker for `<id>@ticket.lansburysquare.co.uk`;
  board-provisioned main-domain aliases go to the same Worker, which forwards copies (D25, D26).
- **MailerSend** — all outbound mail (OTP, invites, chases, reminders, reports).
- **Cron Triggers** — daily chase + monthly report on the `server` Worker (scoring is on-demand).

No external issue tracker: ticket CRUD is ~10 columns + an events table, and a
vendor product would fight (a) email-addressable ticket ids, (b) the bespoke
role/scope model, and (c) querying full edit history for scoring. Building it is
the lazy option here, and avoids per-seat licences.

## Domain & mail DNS

`lansburysquare.co.uk` is registered through **Cloudflare Registrar** on the
*Lansbury Square* account (`f453e6f1c34f3584556b0ad876e3048e`), zone
`3f4b1555020a108e8260f04017349ba8`, nameservers `rodney`/`elinore.ns.cloudflare.com`.

| Address space | Handled by |
| --- | --- |
| `<id>@ticket.lansburysquare.co.uk` | zone catch-all → `lsq-email` Worker (D25) |
| `<name>@lansburysquare.co.uk` | zone catch-all → `lsq-email`, which looks the alias up in the `config` row `mail_aliases` (a JSON doc) and forwards a copy to each verified destination (D26). Aliases are managed by the board via `/api/mail-aliases` |
| anything else on either domain | catch-all → `lsq-email`, which rejects it |
| outbound `ops@lansburysquare.co.uk` | MailerSend (`MAIL_FROM`, display name `MAIL_FROM_NAME`) |

**Records.** Rows marked *managed* were added by Email Routing; don't hand-edit them.

| Name | Type | Value | Purpose |
| --- | --- | --- | --- |
| `@` | MX ×3 | `route{1,2,3}.mx.cloudflare.net` | inbound, main domain *(managed)* |
| `ticket` | MX ×3 | `route{1,2,3}.mx.cloudflare.net` | inbound, ticket subdomain *(managed)* |
| `@` | TXT | `v=spf1 include:_spf.mx.cloudflare.net include:_spf.mailersend.net ~all` | SPF: **one** record for both Email Routing forwarding and MailerSend |
| `ticket` | TXT | `v=spf1 include:_spf.mx.cloudflare.net ~all` | SPF, subdomain *(managed)* |
| `cf2024-1._domainkey` | TXT | `v=DKIM1; …` | DKIM for Email Routing forwards *(managed)* |
| `ms1._domainkey` | CNAME | `ms1._domainkey.mailersend.net` | DKIM for MailerSend |
| `mta` | CNAME | `mailersend.net` | MailerSend return-path (aligns SPF for DMARC) |
| `_dmarc` | TXT | `v=DMARC1; p=none; rua=mailto:dmarc@lansburysquare.co.uk` | DMARC, report-only. No `dmarc@` alias yet, so aggregate reports bounce; add one (D26) when you want them |

**Setup notes.**
- Email Routing was enabled with `wrangler email routing enable`. The subdomain
  was added via the API (`POST /zones/:zone/email/routing/dns {name}`).
- The `ticket` MX/SPF records don't appear in the dashboard's DNS list. Email
  Routing serves them for the enabled subdomain, so check with
  `dig MX ticket.lansburysquare.co.uk` and don't add them by hand.
- The catch-all → Worker rule was set via the API
  (`PUT /zones/:zone/email/routing/rules/catch_all`), because wrangler only allows
  forward/drop on the catch-all.
- Any new SENDER for the domain must be merged into the single `@` SPF record;
  a second SPF record breaks both.
- Follow-up: move DMARC to `p=quarantine` once the `rua` reports show only
  MailerSend and Cloudflare passing.

## Data model summary

See `migrations/0001_init.sql` for the full DDL. Key ideas:

- **`events` is the audit spine.** Comments, classification changes, status
  changes, markers (D21), SLA config edits, board overrides and chases are all rows. Immutable
  - append-only → "board can dispute anything later" is free. Each row names its
    subject polymorphically via `subject_type`/`subject_id` — `ticket` today,
    `metric_value` (attestations/disputes) and others later, with no schema
    change. No DB-level foreign key on `subject_id` (it points at different
    tables); the app validates the referent.
- **Identity is minimal:** `accounts` hold only id/email/name/active. Role,
  scope, residence and board status are `grants`, not columns.
- **Access is scoped RBAC:** `roles` + `role_permissions` (privileges as data) +
  `grants` (account holds a role scoped to estate/building/unit/organization/
  ticket). One table is both the association/membership lookup and the access
  basis. `buildings`/`units` give the scope hierarchy; `organizations` (agent +
  contractors) + `senders` (email/domain → org; `org_id` NULL = unknown) cover
  external parties.
- **Scoring is data:** each `metrics` row carries a single effective `weight`
  (all rows sum to 1.0; domain is a display label, its weight derived as
  `SUM(weight)`), plus `mode` (binary|proportional) and threshold.
  `metric_values` is latest-row-wins per `(metric_key, service_year)`, so a
  dispute is a superseding insert.

## Inbound email flow

Inbound email is split across **two dedicated Workers** plus a queue, separate
from the API/cron Worker. The `email()` handler runs under a tight budget, so it
does the minimum durably and hands the slow work (sender resolution, Workers AI)
to a consumer off the critical path — where failures retry instead of bouncing
the sender.

```
email to <id>@ticket.lansburysquare.co.uk
  ── email Worker (lsq-email) ─────────────────────────────
  → parse local part → ticket_id
      not a ticket? → setReject (bounce; never enqueued)
  → stash raw message in R2 (may exceed the 128 KB queue limit)
  → enqueue {ticketId, from, subject, rawKey} onto lsq-inbound
  ── ai Worker (lsq-ai), queue consumer ───────────────────
  → already processed (an 'original' attachment row for rawKey)? → ack, skip
  → fetch raw from R2 → parse MIME (postal-mime) → text part, else HTML→text (D28)
  → resolve From:
       accounts.email / account_emails → actor_id, actor_role (a known person, D29)
       senders(email)      → org, role=contractor/agent
       senders(domain)     → org, role=contractor/agent
       else                → upsert senders (org_id NULL), role by domain:
                             personal (gmail, hotmail, …) = resident, else contractor (D29)
  → subject contains "no ai"? → ai_processed=0, skip summary
                     else     → Workers AI summary → ai_summary
  → put attachments in R2 (attachments/<ticket>/<rawId>/<n>-<name>)
  → one D1 batch: events(type='comment', source='email') + attachments rows
    (raw message kept as kind 'original') + enquiry marker if any
  → ack (retry on failure; dead-letters after max_retries)
```

The R2 bucket `lsq-inbound-raw` holds `inbound/` (raw originals) and
`attachments/` (extracted files), both kept for the life of the ticket. The
server binds it read-only as `MAIL` and serves files from
`GET /tickets/{id}/attachments/{attachmentId}` under the ticket's `ticket:read`
scope. Files are sandboxed (`nosniff`, `CSP: sandbox`), and only images and
PDFs are shown inline. The timeline shows each comment's name resolved at read
time; the stored role never changes (D29).

Threading is pure regex on the recipient address — never AI — so the `no ai`
opt-out can never break SLA timing. SLA compliance is derived on read from these
`events` (D13), so the consumer only appends a row — no clock columns to update.

Why three Workers, not one: the email accept path has the tightest execution
budget, and isolating Workers AI behind a queue means a slow/failing model
retries rather than bouncing mail. All three share the one D1; each deploys
independently (`deploy:server|email|ai`). Ticket **classification** for
web-created tickets stays synchronous in the API Worker (`classify.ts`) — it's
not under the email budget and already degrades to "unclassified" on failure.

**Deferred: sender-auth (DMARC) flagging.** Cloudflare stamps SPF/DKIM/DMARC
verdicts into the `Authentication-Results` header before `email()` runs, so a
`dmarc=fail` on a policy-publishing domain would let us flag a spoofed
`From:` (someone forging a known resident/agent to inject into a ticket).
Not built for now: the attack requires a targeted forge against a domain that
publishes DMARC, the fabricated comment is visible in the audited timeline and
easily disowned, and `dmarc=none` (the common case for small contractor
domains) yields no usable signal. Low abuse risk vs. the added branching — we
attribute on `From:` as above and revisit if spoofing is ever observed. Hook
when we do: read `message.headers.get("authentication-results")`, and on
`dmarc=fail` append the event with a `suspicious_auth` flag rather than trust
the attribution.

## Scoring (on-demand, no cache)

Computed per request when a dashboard/report is opened (UJ-10). At this DB size
there's no need to cache:

1. Load active `metrics`.
2. For each **auto** metric, query `events` / `tickets` over the window
   (service year, or a month for reports), apply the working-day calendar
   (holidays JSON + cleaning schedule JSON), compute the raw value.
3. Apply `mode`:
   - `binary`: `result = value >= threshold ? 1 : 0`
   - `proportional`: `result = clamp(value / threshold, 0, 1)`
4. **manual** / **survey** metrics: read latest `metric_values` (skip survey
   metrics until ≥50 non-outlier responses).
5. Projected fee = `Σ (weight × result)` over all metrics.

`metric_values` rows are written only for **manual/survey** inputs and board
disputes — auto metrics are recomputed each time, not stored.

## The one scheduled job (daily Cron Trigger)

A single Cron Trigger does the only things that need a timer:

- **Chase pass (daily, UJ-12):** scan open tickets; for each stale (no update in
  N working days) or near/overdue deadline, append `events(type='chase')`
  and notify the responsible party. It also emails the agents a list of SLA
  instances due today. These reminders are not written as events (D24).
- **Monthly report (configured day, UJ-11):** the daily pass checks whether
  today matches `REPORT_DAY_OF_MONTH` (clamped to the last day for short months)
  — not fixed to the 1st, because it tracks the board/agent meeting schedule,
  which lands mid-month. On a match it runs the report function for the trailing
  month and emails the board. The same function backs the on-demand button.
- **Auth cleanup (daily, D27):** deletes login codes that are expired or used,
  and sessions past their sliding or hard expiry.

Durable Object per-ticket alarms were considered for exact-moment chasing but
rejected — more moving parts for no practical gain at ~200 units; a daily sweep
is indistinguishable in outcome.

## Roles & visibility (scoped RBAC — see D18)

Data-driven, not hard-coded. A request checks: _does this account hold a grant
whose role carries the required permission, scoped to cover this resource?_

- **Roles/permissions** live in `roles` + `role_permissions` — editable data.
- **Grants** attach a role to a scope (`estate`/`building`/`unit`/
  `organization`/`ticket`). agent/admin get an estate-scoped grant; a resident a
  unit- or building-scoped one; a board member holds both a resident grant and a
  board grant. Ticket-level grants give per-ticket sharing with no schema change.
- **Scope covers a resource** by hierarchy: estate ⊇ building ⊇ unit ⊇ ticket
  (resolved via `units.building_id` and the ticket's unit/building), plus
  `organization` for org-scoped access.
- Deliberately minimal scoped-RBAC — **no** role inheritance, per-field ACLs, or
  ABAC conditions yet. Add those only if a real policy needs them.

## Config (JSON, not tables)

- Holiday calendar (UK bank holidays + site closures).
- Per-contractor on-site schedules (for the cleaning "1 working day" clock).
  Kept as config because they change rarely and never need querying.

## Deferred (YAGNI — add when needed)

- Role inheritance / ABAC conditions / per-field ACLs — the scoped-RBAC above is
  the foundation; add richer policy only when a real rule needs it.
- Notification transport beyond email — start with email via MailerSend.
