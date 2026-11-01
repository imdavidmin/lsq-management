# Plan — Scoring engine + SLA definitions

> **Status: delivered (D21, D23).** Steps 1–7 are built. The appendix traces are
> what `server/test/scoring.test.ts` checks, and D21 links here, so move them
> before deleting this file.
> Out-of-scope items are parked in [parked.md](parked.md).

## Context

SLAs are **defined in the UI** as a few generic types that the system evaluates
from elapsed time between ticket events (D21). This replaces an earlier draft
that hard-coded SLA "clocks" in code. Agreed rules:

- SLAs change only at service-year end. A mid-year edit is allowed and accepted
  to re-score the year (scores are recomputed on read, D13).
- Scores are computed only for the **current** or **just-past** service year.
- At year end, the board generates the final score and stores a **snapshot in
  R2** (score + metric and SLA definitions + per-ticket results). Users must not
  edit SLAs until that snapshot is taken.
- The service year is a setting in the **`config` table**.
- The "no contractor reply in N days" rule isn't an SLA. A **daily cron**
  (config-driven N) injects a system marker into the ticket, and the SLA is the
  1-day agent follow-up after that marker.
- "Enquiry sent" is **inferred automatically**: an agent emails a contractor with
  the ticket address in CC. "Contractor attended" is a **manual** marker added by
  the on-site team, with notes.

## The model: one generic SLA shape

An SLA = **applies-to filter** + **start event** + **stop event** + **budget
(working days)** + **repeats?** + the **metric** it feeds.

Event vocabulary, a fixed list in a new `common/sla.ts` shared by the server and
web (same pattern as `common/tickets.ts`):

| Kind | Value | Matches an `events` row where |
| --- | --- | --- |
| `ticket_created` | — | (start only) the ticket's creation |
| `status` | a `STATUSES` value | `type='status'` and `to_value` = value |
| `event_by` | `staff` \| `contractor` \| `resident` | any event whose `actor_role` is in the group (`staff` = agent, admin) |
| `marker` | `enquiry_sent` \| `attended` | `type='marker'` and `to_value` = value |

Evaluation, in a pure function in `server/src/lib/sla.ts` that reuses
`workingDaysBetween` from `lib/workdays.ts`:

- Each start match creates one **instance**. With `repeats=0`, only the first
  match counts.
- The stop is the first matching event **strictly after** the start event.
- An instance is **met** if `workingDaysBetween(start, stop) <= budget`. It is
  **breached** if stopped late, or still open past its budget. It is
  **running** if still open within budget, and is then excluded from scoring.
- A metric's value = tickets where **all** of that metric's SLA instances are met
  ÷ tickets with at least one finished or breached instance. That ratio handles
  the contractor metric's "ALL of" rule with no special case.
- The window is tickets created in the service year.

The seeded SLAs from the rubric:

| SLA | Metric | Applies to | Start → stop | Budget | Repeats |
| --- | --- | --- | --- | --- | --- |
| Cleaning resolved | `site.cleaning_tickets` | category=cleaning | ticket_created → status:resolved | 1 | no |
| Acknowledged | `res.ticket_acknowledgement` | all | ticket_created → event_by:staff | 2 | no |
| 3rd-party follow-up | `res.third_party_follow_up` | all | status:pending_3rd_party → event_by:staff | 5 | yes |
| Enquiry to contractor | `con.contractor_attendance` | needs_contractor | ticket_created → marker:enquiry_sent | 2 | no |
| Reply to contractor | `con.contractor_attendance` | needs_contractor | event_by:contractor → event_by:staff | 2 | yes |
| Chase silent contractor | `con.contractor_attendance` | needs_contractor | marker:enquiry_sent → event_by:staff | 6 | yes |
| Update after attendance | `con.contractor_attendance` | needs_contractor | marker:attended → event_by:staff | 2 | yes |

`site.site_inspection` stays a hard-coded ratio (an auto metric with no SLAs
linked).

## DB schema (in `migrations/0001_init.sql`)

```sql
-- SLA definitions (D21): evaluated on read against ticket events; never stored per ticket.
CREATE TABLE slas (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  metric_key       TEXT NOT NULL REFERENCES metrics(key),
  category         TEXT,                 -- NULL = any category
  needs_contractor INTEGER,              -- NULL = any; else 0/1
  start_on         TEXT NOT NULL CHECK (start_on IN ('ticket_created','status','event_by','marker')),
  start_value      TEXT,
  stop_on          TEXT NOT NULL CHECK (stop_on IN ('status','event_by','marker')),
  stop_value       TEXT,
  budget_days      INTEGER NOT NULL CHECK (budget_days > 0),
  repeats          INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1
);
```

- The migration seeds the 7 rows above.
- New permissions: `sla:read` (seed for `agent`) and `sla:manage`, plus
  `score:snapshot`. Board and admin already have `*`.
- **No delete.** Deactivate instead (`active=0`).
- **Edits are audited on the spine (D7/D19):** each create or update appends
  `events(subject_type='sla', subject_id=id, type='config', from_value=<old
  JSON>, to_value=<new JSON>)`.
- **New `events.type` values:** `marker` and `config` (the column has no CHECK,
  so no schema change). Update the comment in `migrations/0001_init.sql`.
- Values are validated with zod against `common/sla.ts`:
  - `start_value`/`stop_value` must fit their kind.
  - `metric_key` must be a `source='auto'` metric.

**Config.** Two rows in the existing `config` table, seeded by the migration:
`service_year_start = '08-01'` (MM-DD).

The service year is labelled by the calendar year it starts in. `/score` accepts
only the current or previous year; any other year returns a 400 via
`lib/errors.ts`.

**Snapshot.** Add an R2 binding `SNAPSHOTS` (bucket `lsq-score-snapshots`) to
the root `wrangler.jsonc` and `server/src/env.ts`.

- `POST /score/snapshots {year}` (`score:snapshot`) writes
  `snapshots/{year}/{takenAt}.json` containing the score, metrics, SLAs,
  per-ticket instances, and the year's `sla` config events. It also appends a
  `snapshot` event.
- `GET /score/snapshots` lists snapshots, and `GET /score/snapshots/{key}`
  downloads one.

## Signals feeding the markers

- **`enquiry_sent` (automatic).** In `ai/src/process.ts`, once the sender
  resolves to `agent`, parse the `To` and `Cc` headers from the raw message
  (already fetched from R2). If any recipient matches a contractor sender rule,
  using the same email-then-domain lookup as `resolveSender`, also append a
  `marker` event with `to_value='enquiry_sent'`.
- **`attended` (manual).** Add `POST /tickets/{id}/markers
  {marker:'attended', notes}`, gated by `ticket:update`. On the ticket detail
  page, a "Contractor attended" button opens a dialog with a notes field. The
  notes go in the event `body`.

## Editor UI

The editor is a new **"SLAs"** tab in `web/src/features/scoring/PerformancePage.tsx`,
shown when `has("sla:read")`. It's editable only with `sla:manage`; agents get a
read-only view.

```
┌ SLAs ───────────────────────────────────────────────── [+ New SLA] ┐
│ ⚠ Service year 2025 has no snapshot yet — editing SLAs re-scores it. │
│                                                                     │
│ ▾ Resident & Board Service · res.ticket_acknowledgement, res.third_party_follow_up          │
│   Acknowledged          all tickets   created → staff reply   2 wd  ●│
│   3rd-party follow-up   all tickets   ⟳ pending → staff reply 5 wd  ●│
│ ▾ Contractor Management · con.contractor_attendance  (ticket passes if ALL met)│
│   Enquiry to contractor needs contr.  created → enquiry sent  2 wd  ●│
│   Reply to contractor   needs contr.  ⟳ contractor → staff    2 wd  ●│
│   ...                                                               │
└─────────────────────────────────────────────────────────────────────┘
```

Clicking a row, or "New SLA", opens a Fluent `OverlayDrawer` with a form you
read as a sentence:

```
Name        [ Reply to contractor              ]
Counts toward [ con.contractor_attendance ▾ ]

For  [ any category ▾ ]  tickets  [ needing a contractor ▾ ]
from [ an event by… ▾ ] [ contractor ▾ ]
until[ an event by… ▾ ] [ staff ▾ ]
within [ 2 ] working days    [x] Repeat each time the start happens

Preview: "For tickets needing a contractor, every contractor reply must
          get a staff response within 2 working days."
Active [●]                                   [Cancel] [Save]
```

- The value dropdown changes with the kind (statuses, role groups or markers),
  driven by `common/sla.ts`.
- Group rows by metric domain using the existing
  `web/src/components/CollapsibleGroup.tsx`.
- Hooks (`useSlas`, `useSaveSla`) go in `web/src/features/scoring/api.ts`,
  following the pattern of `useSaveMetrics`.
- The snapshot banner reads `GET /score/snapshots`.
- The **Dashboard** gets a "Take year-end snapshot" button (`score:snapshot`)
  and a list of past snapshots.

## Steps (one PR each, with its test)

1. **Decision and docs.** Add D21 (SLAs as data, evaluated on read, markers,
   config-driven no-reply detection, R2 snapshots). Rewrite
   `docs/plan/plan-scoring-sla.md` and the "what still needs deciding" section of
   `docs/sla-tracking.md`.
2. **Schema and config.** `slas` table in `0001_init.sql`, `common/sla.ts`,
   the SLA + `config` seed rows in `0002_seed.sql`.
3. **SLA API.** `GET/POST/PATCH /slas` in `server/src/segments/scoring/`
   (routes delegate to the service, gated with `requirePermission`), audit
   events, and `openapi.yaml` + `api.md`.
4. **Editor UI.** The SLAs tab and drawer described above.
5. **Signals.** The `enquiry_sent` inference in the ai Worker and the
   `attended` endpoint and button.
6. **Evaluator and score.** `lib/sla.ts`, then `/score` using it, limited to the
   current or previous year (part of the scoring segment from the earlier plan).
7. **Snapshots.** The R2 binding and the snapshot endpoints, plus the Dashboard
   button and list.

## Verification

- `npm install && npm test && npm run typecheck`. Dependencies aren't installed
  locally right now.
- `server/test/scoring.test.ts` (new):
  - SLA CRUD and its permissions (agent can read but not write).
  - An edit appends a `config` event.
  - Invalid kind/value pairs are rejected.
  - `/score` rejects a year older than the previous one.
- An evaluator unit test with event fixtures:
  - met, breached-stopped, breached-open, running.
  - Repeat instances.
  - Stop must come strictly after start.
  - A weekend/holiday crossing.
  - The "ALL of" per-ticket rule.
- `ai/test/process.test.ts`: an agent email with a contractor in Cc → a `marker`
  event; a resident email → no marker.
- `server/test/scheduler.test.ts`: after an enquiry with no contractor reply,
  the marker is inserted once after N working days and isn't duplicated on the
  next run.
- Manual: `npm run be` + `npm run fe`. Edit an SLA in the drawer, see the timeline event and
  score change, then take a snapshot and download it.

---

## Appendix — worked traces, one per SLA type

Conventions used in every trace:

- **Dates.** Real 2026 dates: Nov 2 is a Monday. The holidays come from
  `holidays.json` (Dec 25 and Dec 28).
- **Working days.** `wd(a, b)` = `workingDaysBetween(a, b)`, which counts
  working days *after* `a`'s day up to and including `b`'s day. Same day → 0.
- **Event ordering.** Events are ordered by `(at, id)`. `ticket_created` sits
  before every event row, so the ticket's own creation events can stop an SLA.
  For example, a staff-created ticket counts as acknowledged at 0 wd.
- **Service year.** Config `service_year_start = '08-01'`, so year 2026 runs
  from 2026-08-01 to 2027-07-31.

### 1. Cleaning resolved: `ticket_created → status:resolved`, 1 wd

**Ticket #101, met across a weekend.**

1. Fri Nov 6 16:00. A resident creates the ticket in the UI (`POST /tickets`,
   category `cleaning`). `createTicket` inserts the ticket row
   (`created_at=2026-11-06T16:00Z`) and two events, both by the resident:

   | id | at | actor_role | type | to_value | source |
   | -- | -- | -- | -- | -- | -- |
   | 1 | 11-06 16:00 | resident | comment | — | ui |
   | 2 | 11-06 16:00 | resident | classify | cleaning | ui |

2. Mon Nov 9 11:00. The agent sets the status to resolved
   (`PATCH /tickets/101`). `patchTicket` appends a status event:

   | id | at | actor_role | type | from_value | to_value |
   | -- | -- | -- | -- | -- | -- |
   | 3 | 11-09 11:00 | agent | status | open | resolved |

3. Evaluator. The filter `category=cleaning` matches. There is one instance:
   start Nov 6, stop event #3. `wd(Nov 6, Nov 9)` counts Sat, Sun and Mon, of
   which only Monday is a working day, so the result is 1. **1 ≤ 1 → met.**

**Ticket #102, met across the holidays.** It's created Thu Dec 24 and resolved
Tue Dec 29. Counting the days after Dec 24: Dec 25 is a holiday, Dec 26–27 are
the weekend, and Dec 28 is a holiday, so only Dec 29 counts. The result is 1, so
**met**. If it had been resolved Wed Dec 30, the result would be 2, so
**breached**.

### 2. Acknowledged: `ticket_created → event_by:staff`, 2 wd

**Ticket #110 (complaint), breached.**

1. Mon Nov 2 09:00. A resident creates the ticket. Events #10 (comment) and #11
   (classify) are both by the resident, so neither is a staff event.
2. Tue Nov 3. The resident adds a comment (event #12). Its `event_by` group is
   resident, so it doesn't stop the SLA.
3. Thu Nov 5 10:00. The agent replies by email to `110@lansburysquare.co.uk`:
   - **email Worker:** the local part `110` matches a ticket. It stores the raw
     message in R2 and enqueues `{ticketId:110, from, subject, rawKey}`.
   - **ai Worker:** `resolveSender` finds the sender in `accounts`, and their
     grants make them an agent. It writes the summary, then appends event #13:
     `comment`, `actor_role=agent`, `source=email`.
4. Evaluator. The stop is event #13. `wd(Nov 2, Nov 5)` = 3 (Nov 3, 4 and 5).
   **3 > 2 → breached.**

### 3. 3rd-party follow-up: `status:pending_3rd_party → event_by:staff`, 5 wd, repeats

**Ticket #120.**

1. Mon Nov 9 10:00. The agent sets the status to `pending_3rd_party`. This is
   event #20, a status event by the agent, and it starts **instance A**. The
   event itself can't stop instance A, because the stop must come strictly
   after the start.
2. Fri Nov 13. The agent comments (event #21), which stops instance A.
   `wd(Nov 9, Nov 13)` = 4. **A is met.**
3. Mon Nov 16. The agent sets the status back to `open` (event #22). Wed Nov 18
   10:00, the agent sets it to `pending_3rd_party` again (event #23), which
   starts **instance B**.
4. No staff event follows. Scored on Thu Nov 26, `wd(Nov 18, Nov 26)` = 6
   (Nov 19, 20, 23, 24, 25 and 26). **B is breached while still open.**
5. For `res.third_party_follow_up`, a ticket passes only if all its instances are met.
   **Ticket #120 fails.**

If the score had been viewed on Mon Nov 23 instead, `wd(Nov 18, Nov 23)` = 3,
so B would still be **running**. The ticket would then be scored on instance A
alone.

### 4. Enquiry to contractor: `ticket_created → marker:enquiry_sent`, 2 wd

**Ticket #104 (site_defect).** This ticket is reused in traces 5 and 7.

1. Mon Nov 2 09:00. A resident creates the ticket (events #30 and #31).
   At 11:00 the agent sets `needs_contractor` (event #32:
   `status needs_contractor:0 → needs_contractor:1`).
2. Tue Nov 3 14:00. The agent emails the contractor:
   `From: sam@agentco.co.uk`, `To: info@fixit.co.uk`,
   `Cc: 104@lansburysquare.co.uk`.
   - **email Worker:** the Cc address resolves to ticket 104. It stores the raw
     message in R2 and enqueues it.
   - **ai Worker:**
     1. `resolveSender` finds `sam@` in `accounts`, so the sender is an agent.
     2. **New:** parse `To`/`Cc` from the raw message. `info@fixit.co.uk` has
        no email rule, but the domain rule `fixit.co.uk` belongs to an
        organisation with `kind=contractor`. That's a match.
     3. Append event #33 (`comment`, agent, email) and event #34 (`marker`,
        `to_value=enquiry_sent`, agent, email).
3. Evaluator. The filter `needs_contractor=1` matches (it uses the current
   ticket state). The stop is marker #34. `wd(Nov 2, Nov 3)` = 1.
   **Met.**

### 5. Reply to contractor: `event_by:contractor → event_by:staff`, 2 wd, repeats

**Ticket #104, continued.**

1. Wed Nov 4 09:00. `bob@fixit.co.uk` replies with the ticket in CC. The ai
   Worker matches Bob through the domain rule, so the sender is a contractor.
   It appends event #35 (`comment`, contractor). This starts **instance A**.
2. Thu Nov 5 08:00. Bob sends a second email (event #36), which starts
   **instance B**.
3. Fri Nov 6 12:00. The agent comments in the UI (event #37), which stops both
   instances:
   - A: `wd(Nov 4, Nov 6)` = 2. **Met.**
   - B: `wd(Nov 5, Nov 6)` = 1. **Met.**

### 6. Chase silent contractor: `marker:enquiry_sent → event_by:staff`, 6 wd, repeats (D24)

**Ticket #105 (needs_contractor).**

1. Fri Nov 6. A resident creates the ticket.
2. Mon Nov 9 10:00. The agent emails `info@fixit.co.uk` with the ticket in CC.
   Events #40 (`comment`) and #41 (`marker enquiry_sent`) are appended, as in
   trace 4. #41 starts **instance A**. The comment #40 comes before it, so it
   can't stop A.
3. Thu Nov 12 10:00. The contractor hasn't replied, and the agent chases early
   by email. Comment #42 stops A: `wd(Nov 9, Nov 12)` = 3. **Met.** Marker #43
   starts **instance B**.
4. The contractor still doesn't reply. The daily cron (02:00 UTC, working days
   only) evaluates the running instances:
   - Thu Nov 19 run: B is at `wd(Nov 12, Nov 19)` = 5. Not due yet.
   - Fri Nov 20 run: B is at 6, its budget, so it is due today. The cron emails
     the agents "#105: Chase silent contractor". No event is written.
5. Fri Nov 20 15:00. The agent chases again (#44, #45). B is **met** at 6, and
   #45 starts instance C.
6. If the agent hadn't acted until Mon Nov 23, B would be at 7, so the SLA would
   be **breached**.

A contractor reply doesn't stop the instance, but the agent's answer does, and
"Reply to contractor" already requires that answer within 2 working days.

### 7. Update after attendance: `marker:attended → event_by:staff`, 2 wd, repeats

**Ticket #104, continued.**

1. Mon Nov 9 15:00. The on-site team member opens ticket #104, clicks
   **Contractor attended**, and enters the notes "Fixit replaced door closer,
   lobby B".
   - This calls `POST /tickets/104/markers {marker:'attended', notes}`, which
     checks `ticket:update`.
   - It appends event #38: `marker`, `to_value=attended`, the staff member's
     role, `body`=the notes, `source=ui`.
   - The marker itself can't stop its own instance, because the stop must come
     strictly after the start.
2. Wed Nov 11 10:00. The agent posts the outcome and next action as a comment
   (event #39). `wd(Nov 9, Nov 11)` = 2. **Met.**

> Open point surfaced by this trace: should the notes on the attended marker
> themselves count as the "update with outcome + next action"? As modelled,
> they don't, so a separate staff update is required. If the board says the
> notes are enough, change this SLA's stop to "staff event at or after start"
> rather than adding a flag.

### Roll-up: from SLA instances to the fee

`GET /score?year=2026` (on Nov 26, 2026):

1. Check the year is the current or previous service year. 2026 is current, so
   proceed. 2024 would get a 400.
2. Load the active `slas` grouped by `metric_key`, the tickets created between
   2026-08-01 and 2027-07-31, and their ticket events. That's one query each.
3. Work out each ticket's instances for each metric, and drop the running ones.
4. Take `con.contractor_attendance` (4 SLAs) as an example:
   - #104 passes: enquiry, reply A, reply B and attendance all met.
   - #105 passes: enquiry and chase both met.
   - Suppose #106 breached one instance.
   - Value = 2/3 = 0.667. The metric is proportional with threshold 0.85, so
     the result is 0.667/0.85 = 0.784.
   - It contributes 0.0525 × 0.784 = **0.041** to `projected_fee_ratio`.
5. Manual and survey metrics are read from `metric_values` as before, and the
   fee is Σ(weight × result).
   - **Projection.** For the ongoing service year, a manual or survey metric
     with no stored value (or a survey below its 50-response gate) is
     **assumed met** (result 1) and returned with `pending: true`, so the fee
     is a best-case projection. For the just-past year it scores 0.

### Year end: snapshot, then edit

1. Mon Aug 2, 2027. The board clicks **Take year-end snapshot** for 2026
   (`POST /score/snapshots {year:2026}`).
   - The full evaluation is written to R2 at
     `snapshots/2026/2027-08-02T09:00:00Z.json`.
   - A `snapshot` event is appended.
   - The banner in the SLA editor ("2026 has no snapshot") disappears.
2. The board changes "Acknowledged" from 2 to 3 wd.
   - This appends a `config` event with `subject_type='sla'`, where
     `from_value` is the old JSON and `to_value` the new.
   - Viewing `/score?year=2026` again now re-scores 2026 under the new rule, as
     agreed.
   - The R2 snapshot still holds the official 2026 figures.
