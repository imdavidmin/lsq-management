# Requirements & Features

Authoritative spec. The scoring rubric here is the source of truth for the
`metrics` rows seeded in `migrations/0002_seed.sql`.

## Functional features

### Ticketing

- Create tickets via **web UI only** (residents, site staff, admins, board).
  No ticket creation by email — this avoids unknown-sender / spam tickets.
- Update existing tickets via web UI **or** email: reply/CC to
  `<ticket_id>@ticket.lansburysquare.co.uk`. The address _is_ the ticket number; no
  subject parsing needed.
- Every update is an immutable event (audit spine). Nothing is destructive.
- Ticket classification (category/scope) drives scoring; see below.

### Email integration

- Inbound via Cloudflare Email Routing → Worker. Not a real inbox — no reading
  or sending from it as a mailbox.
- Sender resolution order: exact `accounts` email (a known person) → `senders`
  email → `senders` domain (→ an organization) → else upsert into `senders` with
  no org (logged as unknown).
- Sender role attributes SLA actions (agent reply, contractor reply, etc.).
- **AI opt-out:** subject contains `no ai` (any casing) → email is threaded and
  timestamped for SLA, but skipped for AI summarisation.

### Classification

- The ticket **creator picks the category** on the create form (optional).
- If left blank → the ticket is **unclassified** until an agent categorises it.
  (AI classification was dropped for now — categories are human-chosen.
  Exception: tickets opened from `management@`/`concierge@` mail are
  classified by a model, D32.)
- Agent may reassign category later; change is **logged**, board disputes
  **later** (not inline). Agent has default authority; board has systems access
  as the ultimate backstop.
- **Category set is provisional.** `tickets.category` is deliberately free-text
  (not a fixed enum) for now: the real-world trial will show which categories
  actually occur and which the scoring rubric needs to key off. Freeze it into a
  constrained set / lookup table only once the trial settles it — until then the
  scoring queries treat unrecognised categories as out-of-scope rather than
  assuming a closed list.

### Scoring & performance fee

- Performance fee = composite score across the domains below.
- Computed **on-demand** (per request, no cache — D13); projected fee visible to
  board and agent at any time.
- Each metric is **binary** or **proportional** (per-metric choice, configurable).
- Board can dispute any computed or entered value (superseding insert).

### Surveys

- In-system questionnaire; **one response per unit** (not per person — the first
  eligible resident of a unit to submit consumes that unit's vote; see
  `docs/surveys.md`).
- A survey metric scores only when **≥50 non-outlier responses** exist.
- Outliers (e.g. 1/5 across all questions) excluded at board discretion.

### Non-ticket data entry

- Financial metrics: entered by **admin** user.
- Physical counts (window cleaning, HIU servicing, etc.): entered by **agent**
  as completed; board can verify/dispute.

### Automation

- Auto-chase when tickets go stale or deadlines approach/pass.
- Reduces agent reporting to board and residents.

### Site information

- A single **markdown** page of static site info (managing-agent contact
  details, out-of-hours number, etc.), stored in a key/value `config` table
  under the `site_info` key.
- Readable by any signed-in user (`config:read`); editable only by **admin**
  (`config:manage`, and board via `*`). Last edit is timestamped.
- No versioning/scoping/audit — it's a single editable blob. Add those only if
  the trial shows a need.

### Roles & visibility (scoped RBAC, data-driven)

Access = `roles` + `role_permissions` (privileges as data) + `grants` (a role
scoped to estate/building/unit/organization/ticket). One `grants` table is both
the association/membership lookup and the access basis (D18).

- **Resident** — a unit- or building-scoped resident grant; sees tickets in that
  scope, plus survey access there.
- **Agent / admin** — an estate-scoped grant (see everything), plus a "my own
  issues" resident-style view via their own resident grant if they have one.
- **Site staff** — an estate-scoped grant: every ticket (full ticket powers)
  and the directory, but no scoring, SLA, report or survey data (D31).
- **Board member** — holds both a resident grant _and_ a board grant; board
  powers (dispute, link senders, full audit) come from the board grant.
- **Granular sharing** — a ticket-scoped grant gives one account access to one
  ticket without any schema change.

## User journeys

Numbered for reference during build (`UJ-nn`). Each is a concrete step sequence
ending in a completed state.

### Ticketing

**UJ-01 — Create a ticket (web UI)**

1. Any signed-in user (resident/staff/admin/board) clicks **New ticket**.
2. Enters title + description; optionally selects building/unit (residents
   default to their own).
3. Optionally picks a **category** (UJ-05). Submits. System creates the ticket,
   assigns an id, and shows the ticket page with its email address
   `<id>@ticket.lansburysquare.co.uk`.
4. Done: ticket is `open`, visible to the creator and everyone in scope.

**UJ-02 — Update a ticket (web UI)**

1. User opens a ticket they can see and types a comment / changes status.
2. Submits. System appends an `events` row (`source=ui`); SLA status is
   derived from it on read (D21).
3. Done: the new event shows in the ticket timeline immediately.

**UJ-03 — Update a ticket by email (CC)**

1. A staff member, contractor, or resident replies/CCs
   `<id>@ticket.lansburysquare.co.uk`.
2. Email Routing → Worker parses the local part to the ticket id (rejects if no
   such ticket — email cannot create tickets).
3. Worker resolves the From address (UJ-04) to attribute the update, runs AI
   summary unless "no ai" is in the subject (UJ-16), appends a `comment` event
   (`source=email`), plus an `enquiry_sent` marker when an agent mails a
   contractor (D21).
4. Done: the reply appears in the ticket timeline, attributed to the sender's
   role.

### Identity

**UJ-04 — Resolve an email sender**

1. Worker receives an inbound email's From address.
2. Looks up in order: `accounts` email (known person) → `senders` email →
   `senders` domain (→ organization).
3. On a match: attaches `actor_id`/`actor_role` (or org + contractor/agent role).
   On no match: upserts a `senders` row with `org_id` NULL (increments
   `hit_count`) and attributes role `null`.
4. Done: the event is stored with whatever attribution was resolvable.

**UJ-05 — Classify a ticket (creator-chosen, agent fallback)**

1. On the create form the creator may pick a category from the provisional set.
2. If picked → category set, `classified_by` = the creator's role; a `classify`
   event records it.
3. If left blank → category is null (unclassified) and the `classify` event
   notes an agent will categorise.
4. Agent opens the ticket and sets/changes the category (`classified_by=agent`).
5. Done: the classification is a `classify` event on the audit spine.

> AI-assisted classification was dropped for the trial (categories are
> human-chosen); revisit once the taxonomy settles. The only Workers AI use is
> inbound email summarisation (UJ-16), in the `ai` Worker. Since D32, tickets
> opened from `management@`/`concierge@` mail are model-classified
> (`classified_by = ai`).

**UJ-06 — Reassign a ticket category (agent)**

1. Agent changes an existing ticket's category.
2. System appends a `classify` event (`from_value`→`to_value`), keeps the agent's
   change live (no inline board approval).
3. Done: change is applied and logged for later board review.

**UJ-07 — Promote an unknown sender (board/admin)**

1. Board opens the **Unknown senders** list (`senders` rows with `org_id` NULL,
   sorted by `hit_count`).
2. Picks an entry and either: link it to an `organization` (set `org_id`),
   create/link a resident `account`, or mark it `ignored`.
3. Done: entry `status` updated; future emails from that address/domain resolve
   automatically (UJ-04).

**UJ-08 — Dispute a value or classification (board, retrospective)**

1. Board reviews a ticket's audit timeline or a metric's value.
2. For a metric: enters a superseding `metric_values` row with a note. For a
   classification: reclassifies (`classified_by=board`).
3. Done: the dispute is the new latest record; nothing is deleted.

### Visibility

**UJ-09 — View tickets by role/scope (scoped RBAC)**

1. User opens the ticket list.
2. System returns tickets the user has a grant to read: for each of the user's
   `grants`, if its role carries `ticket:read` and its scope covers the ticket
   (estate ⊇ building ⊇ unit ⊇ ticket), the ticket is visible. agent/admin hold
   an estate grant (see all); a resident a unit/building grant; a board member
   holds both a resident grant and a board grant.
3. Done: user sees only tickets a grant permits.

### Scoring & reporting

**UJ-10 — View the live performance fee**

1. Board or agent opens the **Performance** dashboard.
2. System computes metrics on-demand (query over `tickets`/`events` + latest
   manual/survey `metric_values`, applying working-day calendars) and projects
   the fee = Σ (weight × result) over all metrics. In an ongoing service year,
   manual/survey metrics not yet scored are assumed met (shown as pending).
3. Done: current projected fee + per-domain, per-metric breakdown shown, no
   caching.

**UJ-11 — Generate a monthly performance report**

1. Triggered two ways: the chase/report **cron** on a configured day of the
   month (`REPORT_DAY_OF_MONTH`, set to land a few days before the board/agent
   meeting — meetings don't fall on month ends), or a board/agent clicking
   **Generate report** for a chosen month. If the configured day exceeds the
   month's length (e.g. 31 in February), the report fires on the last day.
2. The report function windows the same scoring query to that month, narrates
   good vs weak areas and trend vs prior month.
3. Cron path emails the board; button path renders on screen (and is
   downloadable).
4. Done: board has the report without the agent compiling it before a meeting.

**UJ-12 — Auto-chase stale / overdue tickets**

1. Daily **Cron Trigger** scans open tickets.
2. For each that is stale (no update in N working days) or whose deadline is
   near/passed, appends a `chase` event and notifies the responsible party
   (agent/contractor).
3. Done: chases are logged and sent without any human action.

### Surveys & manual data

**UJ-13 — Resident submits a survey response**

1. Resident opens the current survey, answers the questionnaire.
2. Submits. System stores one `survey_ballots` row (unique per unit + survey)
   and one anonymous `survey_responses` row.
3. Done: response recorded; survey metrics remain unscored until ≥50 non-outlier
   responses exist.

**UJ-14 — Admin manages a survey**

1. Admin opens/closes a survey and reviews responses.
2. Flags outliers (e.g. 1/5 across all questions) with `is_outlier=1`.
3. Done: survey-backed metrics (cleanliness, landscaping, communication) can
   score once the ≥50 gate is met.

**UJ-15 — Enter manual metric data (admin financials / agent physical counts)**

1. Admin enters financial figures (spend vs budget, key dates); or the agent
   marks a physical task complete (window cleaning ×2, HIU servicing %).
2. System writes a `metric_values` row (`source=manual`), pending board
   attestation.
3. Board verifies (`attested_by`) or disputes (UJ-08).
4. Done: the value feeds the live scoring (UJ-10).

### AI / privacy

**UJ-16 — AI opt-out on an inbound email**

1. A sender puts "no ai" (any casing) in the email subject.
2. Worker threads and timestamps the email normally (regex on the recipient
   address — SLA timing unaffected) but sets `ai_processed=0` and skips the
   Workers AI summary.
3. Done: the update is fully tracked, just not AI-summarised.

## Non-functional / constraints

- Board-owned and maintained; no per-seat vendor licences.
- Cloudflare Workers + D1 sufficient at ~200-unit scale.
- **Frontend:** Vite + React + TypeScript, **Fluent UI v9** with a softened
  token theme (larger border radius, lighter shadows, warm brand accent) to feel
  consumer-friendly while keeping a professional/legitimate look. Basic tables:
  Fluent **DataGrid**; advanced tables: **ag-grid**.
- Metric scoring is **on-demand** (computed per request; no cache). Only the
  chase + monthly report run on a schedule (Cron Trigger).
- GDPR: no new obligation vs email + Dwellent, but documented (see below).

## GDPR & AI opt-out

- Workers AI (Cloudflare) does not train models on, or use for service
  improvement, the data sent to it, absent explicit consent.
- Residents may still find AI use controversial → the `no ai` subject opt-out.
- Actions: reference Cloudflare Data Processing Addendum (DPA); update the
  community privacy notice for the new tech stack. No change to overall GDPR
  posture vs today.

---

## Scoring rubric (source of truth)

Working days are defined against a holiday calendar (JSON config) and, for
cleaning, the cleaning contractor's on-site schedule (JSON config).

> **How the SLA-clock metrics below actually get computed from `events` is not
> yet settled** — see [sla-tracking.md](sla-tracking.md), which also covers the
> manual scoring-exclusion escape hatch for extraordinary-circumstance tickets.

### Financial Management — 40%

| Wt  | Metric                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 35% | Draft service charge accounts to Board within **4 calendar months** of FY end.                                                                               |
| 15% | Draft service charge budget circulated **≥2 calendar months** before new service charge year.                                                                |
| 20% | Board-appointed external auditor confirms any required adjustments are **not material** and show no systemic deficiency in the agent's accounting processes. |
| 30% | Operational spend vs budget: adjusted\* total ≤ **+5%** of approved budget, **and** no single heading > **+10%** without prior Board approval.               |

\*Adjusted expenditure excludes Board-approved extraordinary expenditure not
reasonably forecast in budget.

### Governance & Administration — 5%

| Wt  | Metric                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------- |
| 70% | All statutory administrative filings filed by deadline.                                                                   |
| 30% | Annual resident meeting held with **≥21 days' notice** and **≤1 month** before the start of the next service charge year. |

### Site Management — 15%

| Wt  | Metric                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 25% | Cleanliness rated **>4.0** in resident survey.\*                                                                                                                                                                                                        |
| 20% | **≥90%** of cleaning request tickets resolved within **1 working day** (per cleaning contractor on-site schedule).                                                                                                                                      |
| 55% | Site-inspection-scoped defect tickets **created by staff ≥60%** of all tickets in scope. Excludes: duplicates; author-linked damage; sudden reactive faults (power outage, burst pipes); out-of-hours criminal damage; cleaning tickets (not a defect). |

### Contractor Management — 15%

| Wt  | Metric                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 35% | For **≥85%** of defect tickets needing off-site contractor attendance, ALL of: initial enquiry to contractor within **2 working days** of ticket creation; where agent response expected, replied within **2 working days**; if no contractor response within **5 working days**, follow-up within **1 further working day**; after each contractor attendance, ticket updated within **2 working days** with outcome + next action. |
| 25% | Landscaping rated **>4.0** in resident survey.\*                                                                                                                                                                                                                                                                                                                                                                                     |
| 20% | **≥85%** HIU servicing completed within the service year.                                                                                                                                                                                                                                                                                                                                                                            |
| 20% | **2×** window cleaning performed on estate in the service year.                                                                                                                                                                                                                                                                                                                                                                      |

### Resident & Board Service — 15%

| Wt  | Metric                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------- |
| 40% | **≥90%** of tickets acknowledged within **2 business days**.                                                  |
| 40% | **≥85%** of tickets requiring follow-up pending 3rd party have an actioned update within **5 business days**. |
| 20% | Communication rated **>4.0** in resident survey.\*                                                            |

### Projects Execution — 10%

| Wt   | Metric                                                   |
| ---- | -------------------------------------------------------- |
| 100% | **≥95%** of self-published project timeline targets met. |

\* Resident survey metrics apply only when **≥50** responses received, excluding
outliers at board discretion.

> The domain % and sub-% above are the human-facing presentation. In the
> `metrics` table each sub-metric stores a **single** effective `weight` =
> domain% × sub-% (all rows sum to 1.0); the domain weight is derived as the sum
> of its rows, so there is one source of truth. Weights are tentative and live in
> the table, so they change without a redeploy.

**Metric keys.** A metric key is `<prefix>.<name>`. The prefix fixes the domain,
and the two must agree whenever a metric is added:

| Prefix | `domain`     | Rubric section              |
| ------ | ------------ | --------------------------- |
| `fin`  | `financial`  | Financial Management        |
| `gov`  | `governance` | Governance & Administration |
| `site` | `site`       | Site Management             |
| `con`  | `contractor` | Contractor Management       |
| `res`  | `resident`   | Resident & Board Service    |
| `proj` | `projects`   | Projects Execution          |

`<name>` is snake_case; the UI derives the metric's label from it
(`con.hiu_servicing` → "HIU servicing", `common/strings.ts`). A metric may
also carry an optional free-text `description`.
