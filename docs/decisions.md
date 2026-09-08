# Design Decisions

Settled decisions and why. New decisions append here.

### D1 — Supplement, not replace, Dwellent

Dwellent stays for service charge, announcements, site info. This system adds
issue tracking + performance scoring. **Why:** Dwellent isn't built for SLA
targets or performance pay, and replacing it is out of scope.

### D2 — Build bespoke on Cloudflare, no external tracker

No Zendesk/Linear/etc. **Why:** per-seat licences, and vendor products fight
email-addressable ticket ids, the bespoke role model, and full-history querying
for scoring. Needs are simple; board-maintained + free to run wins.

### D3 — Ticket creation is UI-only; email is update-only

Email replies go to `<id>@lansburysquare.co.uk` and only update that ticket.
**Why:** removes the unknown-sender-creates-ticket / spam problem entirely. The
address is the ticket number, so no subject parsing.

### D4 — Sender resolution is a lookup, not an identity system

Order: `accounts` email → `senders` email → `senders` domain (→ organization).
No match upserts a `senders` row with `org_id` NULL (logged unknown). Domain rule
classifies a whole company at once.
**Why:** SLA scoring needs the actor's role, but nothing more. Unknown senders
are logged for the board to promote later.

### D5 — Classification: creator-chosen, agent-fallback, board-disputes-later

The creator picks a category on the create form (optional); if blank, the ticket
is unclassified until an agent categorises it. Agent may reassign (logged). Board
disputes later, not inline. **Why:** keeps agent workflow fast; board's systems
access is the real backstop, so inline gating is unnecessary friction. Every
change is on the audit spine.

**Revision:** AI-first classification was dropped for the trial — categories are
**human-chosen** for now (revisit once the taxonomy settles). Web-create latency
and cost don't justify a model call when the creator can just pick. The only
Workers AI use is inbound email summarisation (D9), now isolated in the `ai`
Worker (D20).

### D6 — Scoring is data-driven; binary AND proportional both supported

`metrics` rows carry a weight, `mode`, threshold. **Why:** weights are tentative;
some metrics are naturally pass/fail, others graded. Config beats redeploys.

**Revision:** each row stores a **single effective `weight`** (= domain% × sub-%,
all rows summing to 1.0), not a separate domain_weight + sub_weight. Storing the
domain weight per sub-metric let rows in one domain disagree — no single source
of truth. Domain is now a display label; its weight is derived as `SUM(weight)`.
Fee = `Σ (weight × result)`.

### D7 — Audit spine (`events`) is append-only

All updates/classifications/clock-stamps/overrides are immutable rows. **Why:**
makes "board can dispute anything later" free and tamper-evident, with no
destructive edits.

### D8 — Don't defend against clock/metric gaming in software

The board has systems access and can call out abuse directly; the agent's
contract renewal (separate from performance fee) rests with the board, so the
incentive to game is low. **Why:** cheaper to govern socially than to build
anti-gaming logic that would never be perfect anyway.

### D9 — "no ai" opt-out skips summarisation only

Subject contains `no ai` (any case) → email still threads + times for SLA,
skips Workers AI summary. **Why:** threading is regex on the recipient address,
so opt-out never affects SLA timing — only the optional AI summary.

### D10 — Nightly scoring, not real-time — SUPERSEDED by D13

~~Cron job recomputes `metric_values` and fires chases nightly.~~ **Superseded:**
scoring is now **on-demand, not cached/nightly** (see D13). Only the chase pass
and monthly report run on the daily Cron Trigger (D14); auto metrics are computed
per request, never stored.

### D11 — Surveys in-system; financial/physical data manually entered

Surveys are a built-in questionnaire (≥50 non-outlier responses to score).
Financials entered by admin, physical counts by agent, all board-verifiable.
**Why:** these can't be derived from tickets; board's dispute power keeps
manually-entered figures honest.

### D12 — GDPR: document, don't re-architect

No new GDPR obligation vs email + Dwellent. Reference Cloudflare DPA, update the
privacy notice, provide the `no ai` opt-out for resident comfort. **Why:** the
data flows are equivalent to today; the change is documentation, not posture.

### D13 — Scoring is on-demand, not cached/nightly

Metrics + projected fee are recomputed on each dashboard/report request; no
nightly scoring job, no cached `metric_values` for auto metrics. **Why:** the DB
is small at 200 units; a query per view is cheap and always current. Only
manual/survey inputs and board disputes are stored.

### D14 — One daily Cron Trigger for chase (+ monthly report)

Chasing needs a timer (nobody loads a page the moment a ticket goes stale), so a
single daily Cron Trigger runs the chase pass and the monthly report.
Durable-Object per-ticket alarms were considered for exact timing but rejected.
**Why:** a daily sweep is the laziest thing that meets the auto-chase goal;
per-ticket alarms add moving parts for no practical gain at this scale.

### D15 — Monthly report: one function, cron + on-demand

A single report function windows the scoring query to a month; the cron calls it
on the date required (emails the board), and a button calls it on demand. **Why:** removes
the agent's pre-meeting compilation work with no duplicated code path.

### D16 — Frontend: Vite + React + Fluent UI v9 (softened theme)

React + TypeScript on Vite; Fluent UI v9 with token overrides (border radius,
shadows, warm brand accent) to feel consumer-friendly. Basic tables use Fluent
DataGrid; advanced tables use ag-grid. **Why:** shadcn requires Tailwind (ruled
out by preference); Fluent gives professional/legitimate familiarity for
admin/board and themes acceptably for residents. Mantine noted as the fallback
if resident-friendliness later outranks admin familiarity.

### D18 — Access: scoped RBAC (roles + role_permissions + grants), all data

`accounts` are identity only. Authorization is three data tables: `roles`,
`role_permissions` (permission strings per role), and `grants` (an account holds
a role scoped to estate/building/unit/organization/ticket). `grants` is the
single association/membership lookup _and_ the access basis; a board member is a
resident grant + a board grant (no `is_board` flag). Access check: a grant whose
role carries the permission and whose scope covers the resource
(estate ⊇ building ⊇ unit ⊇ ticket). **Why:** we handle sensitive personal data
and need granular, per-resource control (down to a single ticket) as a
foundation now — retrofitting it later means a full schema migration. This
supersedes the earlier "roles are a fixed enum + `is_board` flag, permissions in
code" position (D16 note / earlier D-notes): the closed-user-base argument held
for _authentication_, but not for _authorization_ over personal data.
Deliberately minimal — no role inheritance, ABAC, or per-field ACLs until a real
policy needs them. Also replaced ad-hoc `accounts.building_id`/`scope`/`is_board`
and the concrete `announcements.building_id`/`board_only` with the one scope
vocabulary (estate/building/unit/organization/ticket).

### D19 — `events` is a generic audit spine, not ticket-only

`events` started as a ticket timeline (hence its ticket-oriented shape), but the
audit spine should hold **any** auditable action, not only ticket ones. Rows now
reference their subject polymorphically via `subject_type`/`subject_id` (`ticket`
today; `metric_value` for board attestations/disputes; more later) instead of a
hardcoded `ticket_id`. **Why:** "board can dispute anything later" (D7) only
holds if non-ticket actions have a home on the spine too — e.g. a metric-value
`attest`/dispute is auditable without being about a ticket. Done now while it's a
schema draft (no migration cost); retrofitting a polymorphic subject onto a live
`events` table later would be painful. **Ceiling:** `subject_id` carries no
DB-level foreign key (it points at different tables by `subject_type`), so the
app validates the referent — the standard trade-off for a polymorphic audit log.

### D17 — Auth: passwordless email OTP + server-side sliding session

Self-hosted on Workers/D1: 6-digit email OTP (hashed, ~10 min, single-use,
attempt-capped, rate-limited) → an opaque server-side session (256-bit token
hashed at rest, httpOnly/Secure cookie, sliding `expires_at` with an absolute
cap). MailerSend sends the mail. Permissions stay in `accounts`, not the auth
layer. **Why:** the user base is closed/board-provisioned with low daily logins,
and every request already loads the account row for role/scope — so a
server-side session gives long-lived, renewable, _revocable_ login more simply
than JWT refresh-token rotation. Auth0/Firebase/Cloudflare Access/Clerk rejected;
see `docs/authentication.md` for full context and rejected alternatives.

### D20 — Inbound email split across three Workers via a queue

Inbound email runs as two dedicated Workers plus a queue, separate from the
`server` (API + cron) Worker: `email` validates the ticket address, stashes the
raw message in R2, and enqueues its key; `ai` consumes the queue, resolves the
sender, summarises (Workers AI), and appends the `events` row. All three share
one D1 and deploy independently (`deploy:server|email|ai`). **Why:** the
`email()` handler runs under the tightest execution budget, so it must return
fast and durably — pushing sender-resolution + AI off the critical path means a
slow/failing model **retries** (dead-letters after 3) instead of bouncing the
sender. R2 carries the raw body because Queue messages cap at 128 KB (attachments).
Supersedes the earlier "one Worker, split later" note (api.md): the split landed
now because the email budget and AI isolation justified it. Shared contracts live
in `common/` (`queue.ts`, `roles.ts`).
