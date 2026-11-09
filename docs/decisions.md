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

Email replies go to `<id>@ticket.lansburysquare.co.uk` (subdomain since D25) and
only update that ticket.
**Why:** removes the unknown-sender-creates-ticket / spam problem entirely. The
address is the ticket number, so no subject parsing.

**Revision (D32):** mail from a *known account* to `management@` or
`concierge@` also opens a ticket. Unknown senders still can't.

**Revision (D33):** a UI comment by someone other than the creator is emailed
to the creator, with the ticket address as Reply-To.

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

**Revision (D32):** tickets opened from `management@`/`concierge@` mail are
classified by a model (`classified_by = 'ai'`). Web-created tickets are still
human-chosen.

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

**Sole exception (D30):** erasing a person rewrites `actor_email` on their
events to point at their tombstone account. Identity columns only; no event is
deleted and no body is changed.

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
The same daily run also sends SLA reminders (D24) and purges dead login codes
and sessions (D27).

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

### D21 — SLAs are data, evaluated on read from ticket events

An SLA is a row in `slas`: applies-to filter (category, `needs_contractor`) +
start event + stop event + budget in working days + repeats? + the metric it
feeds. Start/stop come from a small fixed vocabulary in `common/sla.ts`
(`ticket_created`, `status`, `event_by` role group, `marker`). SLA instances are
computed per request from `events` (D13) and never stored per ticket, so the
reserved `clock` event type is unused. A metric's value is the share of tickets
whose instances are **all** met. Signals the rubric needs that no action records
today become `marker` events: `enquiry_sent` (inferred by the `ai` Worker when
an agent emails a contractor with the ticket in CC), ~~`contractor_no_reply`
(injected by the daily cron after a configured number of working days)~~
(dropped, see D24), and `attended` (entered manually by the on-site team). SLA edits append `config`
events on the spine. SLAs change only at service-year end; a mid-year edit
re-scores the year, accepted. Scores cover only the current and previous
service year (start date in the `config` table); the final figures are kept
as a year-end snapshot in R2. **Why:** the board defines SLAs in the UI without
a redeploy, the rubric fits one generic shape, and recomputing on read keeps a
single code path for scoring, chasing and the ticket view. Supersedes the
"start hard-coded" lean in `sla-tracking.md`. Worked traces per SLA:
`docs/plan/plan-scoring-sla.md`.

### D22 — Subjects can download their own `access_log` trail

`GET /auth/me/access-log` returns the `access_log` rows where
`resource_type = 'account'` and `resource_id` is the caller, joined to the
reader's name, as a CSV attachment (opens in a spreadsheet). Self only, session-gated, no permission —
like `/auth/me`. Shown from the `/my-account` page. **Why:** GDPR right of
access — a resident should see who opened their personal record without asking
the board. Narrows `gdpr.md`'s "no read surface": the app still cannot be used to
read anyone *else's* trail, or to see what a given reader looked at, so the
original concern (the audit trail on the app's own permission surface) holds.
Covers account-record reads only; reads of tickets that mention the resident
are not attributed to them and are not included.

### D23 — The fee is a projection while the year runs

`/score` treats a metric with no value yet — a manual metric not entered, a
survey under its 50-response gate, an auto metric with no finished SLA
instance — as **met** (result 1, flagged `pending`) while the service year is
running, and as **0** once it has ended. Manual values are entered with
`metric:enter`, but overriding an auto or survey metric is a board dispute and
also needs `metric:dispute` (board/admin via `*`). Only the year just ended can
be snapshotted. **Why:** mid-year, "what will the fee be if the agent delivers
what's outstanding" is the useful number, and a value that's missing at year
end should cost the agent rather than flatter them. The dispute permission stops
the measured party overwriting its own computed score, without a role check in
code (D18).

### D24 — Chasing a silent contractor is one 6-day SLA; reminders aren't events

"Chase silent contractor" is `marker:enquiry_sent → event_by:staff`, 6 working
days, repeating: after each enquiry the agent must touch the ticket again within
6 working days. Every chase email to the contractor (ticket in CC) is itself a
new `enquiry_sent`, so the thread can't go cold for more than 6 days. The
`contractor_no_reply` marker, its cron pass and the `contractor_reply_days`
setting are removed. Phone chases don't count unless the agent also emails.
The daily cron emails the agents a list of SLA instances due today (running, at
their budget), on working days only. It writes nothing to `events`.
**Why:** before, the 6 days were split into 5 days of silence (a
system-written marker) plus a 1-day window. A chase logged before day 5 by any
means other than email didn't count. One SLA in the existing vocabulary is
simpler, needs no evaluator change, and keeps derived state out of the audit
spine (D13, D21). The reminder covers every SLA, not just this one.

### D25 — Ticket mail lives on the `ticket.` subdomain

Ticket addresses are `<id>@ticket.lansburysquare.co.uk` (`TICKET_EMAIL_DOMAIN`).
The `email` Worker rejects anything whose domain isn't exactly that, so a
numeric address on the main domain doesn't thread. The server returns each
ticket's address as `reply_to`, so the UI never hard-codes the domain.
**Why:** with tickets on the main domain, every `@lansburysquare.co.uk` address
was a ticket address, which left no room for human ones (`board@`, `ops@`,
`dmarc@`). A subdomain splits the two namespaces with no extra parsing. The
check is still a string comparison on the recipient (D3, D9). Email Routing is
enabled on the subdomain and the zone catch-all covers it. DNS is in
`architecture.md` → *Domain & mail DNS*.

### D26 — Main-domain addresses are board-provisioned aliases

`<name>@lansburysquare.co.uk` addresses (`board@`, `admin@`, …) live in one JSON
document in the `config` table, key `mail_aliases`:
`{ "board": ["a@x.com", "b@y.com"], … }`.
- **Delivery:** the zone catch-all sends main-domain mail to the `email` Worker.
  It reads the document and forwards a copy to every destination of the matching
  name. Unknown names are rejected, and a failed destination doesn't block the
  others.
- **Management:** board and admin manage aliases in the app
  (`PUT`/`DELETE /api/mail-aliases/{local_part}`, `mail:manage`). The agent can
  only list them (`mail:read`). Every change appends a `config` event
  (subject type `mail_alias`, body = the name).
- **Verification:** the server registers new destinations with Cloudflare
  (`CF_EMAIL_TOKEN`), which emails each a verification link. The Worker can only
  forward to verified addresses.
- **Validation:** all-digit names and destinations on our own domains are
  rejected.
- **Changes go through the app.** Editing the row directly in D1 skips the
  audit event and destination registration, so don't.

**Why:**
- **Copies:** `board@` should reach every board member. A Cloudflare forward
  rule allows exactly one destination ("forward action must contain exactly one
  destination"), but a Worker can call `forward()` once per destination.
- **One `config` row, not a table or KV:** there are a handful of aliases, read
  as a whole on every inbound email, and only the `email` Worker uses them, so
  they don't belong in the relational model. A JSON row in the existing
  key/value `config` table (like `site_info`) keeps D1 the only store, is
  consistent immediately, and records `updated_by`. KV was tried and dropped:
  it added a second storage product and up-to-a-minute staleness, and its
  "edit the JSON by hand" appeal would skip the audit trail.
- **No Cloudflare rules:** routing in the Worker means no per-alias Cloudflare
  rules to keep in sync. The cost is that forwarding depends on the `email`
  Worker, as ticket mail already does.
- **Board-only edits:** `board@` receives the reports and chase digests the
  agent is scored on, so letting the agent re-point it would undo the point of
  the system. That's a permission, not a role check (D18).
- **No hosted mailboxes:** forwarding is free, and nobody runs a mail server.

### D27 — The daily cron purges dead login codes and sessions

`cleanupPass` deletes `otp_codes` rows that are expired or consumed, and
`sessions` past their sliding (`expires_at`) or hard (`hard_expires_at`) expiry.
It runs in the existing daily Cron Trigger (D14), alongside the chase pass and
SLA reminders.
**Why:** nothing removed these rows, so both tables grew forever. Expired codes
and sessions are already rejected on read, so deleting them changes no
behaviour. They aren't audit data; `events` and `access_log` keep their own
retention rules (`gdpr.md`). This was preferred to moving codes or sessions to
KV for its automatic expiry, for three reasons:
- KV has no atomic increment, so the attempt cap wouldn't hold.
- A KV delete takes up to a minute to reach every location, so a used code or
  a logged-out session would keep working briefly.
- The sliding session expiry would use up KV's free-tier write budget.

### D28 — Inbound mail is parsed; originals and attachments are kept

The `ai` Worker parses each message with `postal-mime` (pinned exact) and
stores the plain-text part as the comment body. If there's no text part, it
uses the HTML part converted to text. The raw message is no longer deleted
from R2: it's recorded as the comment's `original` attachment.
- **Attachments:** each one is written to R2 and listed in `attachments`.
- **Atomic write:** the comment, its attachment rows and any enquiry marker go
  in one D1 batch. A queue retry finds the `original` row and does nothing.
- **Serving:** the server serves files under the ticket's `ticket:read` scope
  with `nosniff` and `CSP: sandbox`. Only images and PDFs show inline.
- **UI:** quoted reply history collapses, but the stored body keeps it.
- **Supersedes** the "naive MIME" note in the old `extractText`.
- **Erasure (D30):** the originals a person sent are deleted when they are.

**Why:**
- **Readability:** real mail is multipart, and the old cut at the first blank
  line stored MIME boundaries and base64 as the comment.
- **Keeping the original:** the raw message is the evidence behind an emailed
  update, and the board may need it in a dispute (D7).
- **Pinned 2.x line:** the newer 4.x line had about a dozen releases in the
  month before adoption. Mail from strangers goes through this parser, so
  maturity matters more than features.
- **Sandboxing:** files from strangers served from our origin are a stored-XSS
  risk unless they're sandboxed and downloaded.

### D29 — Extra addresses per person; unknown senders get a default role

`account_emails` lists extra addresses a person sends from. Inbound attribution
matches `accounts.email`, then `account_emails`, then sender rules. Login codes
and notifications only ever use `accounts.email` (D17).
- **Uniqueness:** an address belongs to at most one account, primary or extra.
- **Managing addresses:** board/admin add or remove them on the account
  (`account:manage`).
- **Linking unknown senders:** anyone with `sender:manage`, the agent
  included, can link an unknown email sender to a person. That moves the
  address onto the account and removes the sender row.
- **Default role:** an unknown sender, or a sender rule with no organization,
  gets a role by domain. A personal mail domain (`common/senders.ts`: gmail,
  hotmail, icloud, …) means `resident`; anything else means `contractor`.
  Before this, the role was `null`, which counted for no SLA.
- **Display names:** the timeline resolves a display name at read time, by
  `actor_id` or by `actor_email` through the account's addresses. The stored
  `actor_role` is never re-derived.

**Why:**
- **Second addresses:** residents write from more than one address, and an
  account was one address.
- **Default role:** it makes the common case right without anyone linking
  anything. A resident on gmail counts as a resident, and a firm on its own
  domain counts as a contractor, so linking an address later rarely changes
  SLA outcomes.
- **Names, not roles, at read time:** re-deriving roles would rewrite history
  and shift past SLA results. Names are display-only, so resolving them at read
  time keeps the audit trail intact (D7, D21).
- **No login from extra addresses:** that keeps one login identity per person.
- **Agent linking:** the agent already triages unknown senders, and D8 covers
  the residual gaming risk.

### D30 — Deleting a person tombstones the account; the ticket record stays

Moving out and deleting an account are one manual board action
(`DELETE /accounts/{id}`, `account:manage`). The `accounts` row is kept as an
anonymous tombstone rather than removed:
- **Label:** `name` becomes `Resident of Flat 12, Banbury Point` (from their unit
  grants; several units joined by `; `). With no unit, it's the role name,
  plus the organization when org-scoped (`Managing Agent`, `Contractor, Acme Ltd`).
- **Removed:** email (set NULL), grants, sessions, login codes, extra addresses
  (D29). `active = 0`, `erased_at` is set. Tombstones are hidden from the
  directory and can't be revived or granted access.
- **Scrubbed:** events whose raw `actor_email` is one of their addresses get
  `actor_id` = the tombstone and `actor_email` = NULL (the one D7 exception).
  Their raw `original` emails are deleted from R2 along with the attachment rows.
- **Kept:** event bodies and AI summaries, ticket titles, file attachments,
  `tickets.created_by`, survey ballots, metric entries and `access_log`, all
  still pointing at the tombstone.
- **Audit:** an `erase` event (subject `account`) records who erased whom,
  holding only the label.

**Why:**
- **Tombstone over delete:** a dozen tables reference `accounts.id` and events are
  append-only. A tombstone keeps every reference valid, and every place that
  shows a name shows the label with no extra code.
- **Household label:** the estate needs to know which flat raised or chased
  a ticket for the scoring record. It doesn't need to know who.
- **Scrub identifiers, keep content:** raw addresses and `.eml` files identify
  the person directly and add nothing to the record. Free text is the record
  itself; redacting it would gut the history. Residual names in free text are
  covered by legitimate interest and handled by manual redaction on request
  (docs/gdpr.md).
- **Manual, not on a retention timer:** move-outs are infrequent, and the
  board knows when they happen.

### D31 — Site staff: whole-site ticket access, no performance or survey data

`site_staff` is a role for people who work on the estate day to day: concierge,
caretaker, cleaners. They may be employed by the managing agent, a third-party
provider, or the estate directly.
- **Grant:** estate-scoped, like the agent's.
- **Permissions:** `ticket:*`, `account:read`, `dir:read`, `org:read`,
  `config:read`. They get no `score:`, `report:`, `metric:`, `sla:`,
  `survey:`, `sender:` or `mail:` permissions.
- **SLAs count them as staff:** `ROLE_GROUPS.staff` includes `site_staff`. A
  site-staff reply stops a staff SLA. A site-staff ticket counts as raised by
  staff for site inspection, and their email to a contractor is an enquiry.
- **Precedence:** between `agent` and `contractor` (`common/roles.ts`).
- **Employer isn't recorded.** The grant carries no organization.

**Why:**
- **No scoring or survey access:** performance data, and the resident surveys
  that feed it, are a matter between the board and the agent. They're above
  site staff's job role.
- **Replies count:** the resident gets a response whoever on site sends it. That
  is what the SLAs measure.
- **No employer:** no rule depends on it yet (D8). If one does, add a second,
  org-scoped grant (D18), not a column.
- **Coarse access for now:** finer directory access, such as hiding resident
  contacts from a third-party cleaner, waits until a real need (docs/gdpr.md).

### D32 — Mail to `management@` and `concierge@` from known people opens a ticket

`management@` and `concierge@` are aliases (D26) and are still forwarded as
before. When the sender is a known account (primary or extra address, D29), the
`ai` Worker also triages the message:
- **Classify:** a free Workers AI text model (JSON mode) picks one category from
  `common/tickets.ts` and an `urgent` flag. Information requests are
  `resident_query`. The model only returns labels. Every mail we send is a
  fixed template, so a crafted email can't make us send its text.
- **Ticket:** created with the sender as `created_by` and `classified_by = 'ai'`.
  The email becomes the first comment, with its original and attachments
  (D28). A sender with exactly one unit grant gets that unit and its building.
  Otherwise both are left blank.
- **Notice:** a short email goes to the destinations of the inbox the mail was
  sent to. The ticket address is in CC, so replies thread (D3). It's sent from
  `new@ticket.lansburysquare.co.uk` and isn't logged: the `email` Worker drops
  ticket mail whose `From:` header is that address.

  **Revision (D34):** the notice is now the sender's own email re-sent with a
  banner, with the sender as Reply-To.
- **Urgent:** the sender gets the auto-reply in the `config` row
  `urgent_reply`, which points to 999, the police (101) and Tower Hamlets
  Council. Board and admin edit it under *Directory → Email forwarding*
  (`mail:manage`, audited as a `config` event). Its Reply-To is the ticket
  address. It's logged word for word as a `system` comment, so it stops no
  SLA (D21).
- **Not triaged:**
  - unknown senders and sender-rule matches (they have no account)
  - mail with `no ai` in the subject (D9: no models at all)
  - auto-submitted mail (out-of-office replies, bounces)

  These are forwarded only. A person opens a ticket by hand if needed.
- **Model failure:** the ticket is still opened, unclassified, for the agent to
  categorise (D5).

**Why:**
- **Inbox decides who's told:** the two inboxes are separate identities. The
  people behind each one re-forward if they're the wrong party, so there's no
  category-to-person table to maintain.
- **Known senders only:** D3's spam concern applies to strangers. An account
  holder is someone we already serve, and `created_by` is never null.
- **Forward still happens:** Workers can only `forward()` in the `email()`
  handler, before triage has run. Forwarding first also means a model error or
  a wrong label never loses the mail. The cost is that recipients get two
  emails, the forwarded original and the notice.
- **A dedicated `new@` sender, not a signed header:** MailerSend's custom
  headers need a paid plan. Ticket local parts are numbers, so `new@` can't
  collide with a ticket and is used for nothing else. Other mail from
  `ops@` to a ticket is still logged. If someone spoofs `new@`, their mail is
  dropped, which costs nothing.
- **Reply text is data:** the wording carries legal and safety weight and will
  change. The board edits it without a deploy, and the event log shows who
  changed it.
- **Free model, labels only:** a classifier needs no paid model at this volume.
  Better models or RAG for information requests come later.
- **Cautious auto-reply:** it reads "if this is urgent or someone is in
  danger…" rather than telling the sender it's a police matter. A false
  positive costs one unneeded email, while a missed emergency costs much more.
  The prompt tells the model to treat everyday nuisance such as music or
  footsteps as a plain `complaint`.

### D33 — A UI comment by someone other than the creator is emailed to the creator

When a comment is posted in the UI by anyone other than the ticket's creator,
the creator gets it by email:
- **To:** the creator's `accounts.email` only (D17). Nobody is emailed when the
  creator comments on their own ticket, or when the creator is inactive, erased
  or has no address.
- **From** `noreply@ticket.lansburysquare.co.uk`, **Reply-To** the ticket
  address, subject `Re: <title> [#<id>]`. The ticket address is not in CC.
- **Markers** (e.g. *attended*) aren't emailed. Only comments are.
- **Failure:** a send failure is logged. The comment is already saved and the
  request still succeeds.

**Why:**
- **No CC:** the comment is already on the ticket, so a copy to the ticket
  address would only come back as a duplicate. Reply-To is enough for the
  creator's reply to thread (D3). The `email` Worker also drops ticket mail
  from `noreply@`, as it does for `new@` (D32), in case a client copies it in.
- **Creator only:** they raised it and are the one waiting on an answer. Wider
  recipient lists (everyone on the thread) and internal notes that aren't
  emailed are deferred until there's a real need (D8).

### D34 — Triage re-sends the sender's email with a banner, in place of the notice

The D32 notice is replaced by a copy of the sender's email to the same people:
- **From:** `"<sender name> via Lansbury Square" <new@ticket.lansburysquare.co.uk>`.
  **Reply-To:** the sender. **CC:** the ticket address. **Subject:**
  `[#<id>] <original subject>`.
- **Banner** at the top: the ticket was created automatically, its category,
  a link to it in the app, and "Use Reply all to log replies automatically on
  this ticket." It doesn't mention the urgent auto-reply.
- **Body:** the original email as sent (its HTML, else its text). Attachments
  aren't re-sent; the banner says they're on the ticket.
- The plain Cloudflare forward of the original still goes out first (D32).

**Why:**
- **Reply all does the right thing:** mail clients answer the Reply-To, so
  Reply all goes to the sender plus the ticket address and the reply is
  logged (D3). Plain Reply reaches the sender only, hence the banner wording.
- **Not From the sender:** sending as a gmail.com or hotmail.com address fails
  their DMARC, so it would be spam-foldered or refused, and MailerSend only
  sends from our domain. "via" names it as the sender, the way Google Groups
  does.
- **Keep the free forward:** it's delivered before triage runs, so a model,
  database or queue failure never loses mail. The cost is two emails per
  message, the same count as D32's notice, and the `[#id]` subject marks the
  one to reply to.
- **No attachments:** they're in the forward and on the ticket. Re-sending
  them would hit MailerSend's 25 MB limit and double the traffic.
- **Relaying the sender's text:** D32 sent fixed templates only. This copy goes
  to the same people the plain forward already reaches, so it exposes no one
  to anything new. The model still only returns labels.

### D35 — System mail is HTML with a plain-text part

Every email we send has an HTML part and a plain-text part with the same
content. The HTML comes from templates in `common/email-templates/`: one
layout (logo header, white card, footer) plus one file per email. `{{x}}` is
escaped and `{{{x}}}` takes HTML the code has already built. The login code is shown large in its own box and starts the
subject line. Links to tickets and the logo use the `APP_URL` var (the live
site), because cron and queue Workers have no request to take an origin from.

**Why:**
- **Readable at a glance:** the code is what people look for, so it's large and
  also in the subject, which shows in phone notifications.
- **PNG logo:** Gmail and Outlook don't display SVG, so `web/public/logo-email.png`
  is a PNG copy of the logo, linked rather than attached. Clients that block
  images still show the name beside it.
- **Inline styles and tables:** mail clients drop `<style>` blocks and modern
  layout. Everything a user wrote is escaped before it goes into the HTML.
