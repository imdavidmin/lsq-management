# GDPR & Data Privacy

How the system treats personal data (PII), the compliance strategy, and the
privacy safeguards against misuse — by residents, managing agents, and the board
alike. Pairs with [security.md](security.md) (auth, transport, rate limiting) and
D18 (scoped Role-Based Access Control (RBAC)).

## What personal data we hold

| Data                                                | Table(s)            | Sensitivity              |
| --------------------------------------------------- | ------------------- | ------------------------ |
| Name, email                                         | `accounts`          | PII                      |
| Which units a person is associated with             | `grants`            | PII (household)          |
| Ticket contents (issues, correspondence, unit refs) | `tickets`, `events` | PII, sometimes sensitive |
| Inbound sender emails / domains                     | `senders`           | PII                      |
| Survey answers                                      | `survey_responses`  | opinion, **anonymised**  |
| Who voted in a survey                               | `survey_ballots`    | PII (participation only) |

We deliberately hold **no** special-category data (health, etc.); ticket free
text may incidentally contain it — treated as sensitive, access-controlled and
audited.

## Compliance strategy (D12: document, don't re-architect)

- **Data minimisation.** `accounts` is identity-only (name, email, active).
  Everything else hangs off it by reference.
- **Purpose limitation.** Data exists to run tickets, scoring, and comms for the
  estate. No secondary use, no third-party processors beyond MailerSend (email
  transport) — a documented processor.
- **Lawful basis.** Legitimate interest of the freeholder/board in managing the
  estate; residents are informed. No marketing, no profiling.
- **Retention.** Tickets/events retained while the matter and its scoring window
  are live, then archivable. `access_log` retained for a bounded audit window
  (e.g. 12 months) then purged. Codify exact periods before go-live.
- **Data-subject rights.** Access/erasure served by querying/deleting by
  `account_id`; anonymous survey responses are out of scope for erasure by
  design (they carry no identity).

## Access control (privacy by RBAC — D18)

All PII access flows through scoped Role-Based Access Control (RBAC). A resident sees only tickets in their
unit/building scope; an agent sees operational data but not the board's
administrative surface; grants are the single gate. There is no "read all PII"
path in the API — every read resolves the caller's scope chain first. This is the
primary safeguard against **both** agent and administrator overreach at the
application layer.

## Read-access audit log

State changes already live in the append-only `events` spine (D7). Privacy needs
the _reads_ too: **who viewed which PII-bearing record.**

`access_log` (append-only) records `account_id`, `action` (view/list/export),
`resource_type`, `resource_id`, `at`, optional `detail`. It is written on
PII-bearing reads only — ticket detail/timeline, directory/account records,
survey participation — **not** on every request (that would be noise and cost).

This deters and evidences misuse by agents _and_ board members using the app: a
board member browsing a resident's unrelated tickets leaves a trail. It does not
stop direct-DB reads (see residual risk).

**Writer / reader.** The API middleware *writes* `access_log` on PII-bearing
reads (it is not exposed as a request the app can suppress). The only read
surface is self-service: a person can download the reads of **their own** account
record from `/my-account` (D22). Reviewing the log otherwise is a board tech-op:
whoever holds direct D1 access queries it out-of-band. This keeps the audit trail
off the application's own permission surface (the app can't be used to read who
audited whom) and matches the operating model where the board owns the DB.

## Survey anonymisation

Survey answers carry **no identity**; participation (one-vote-per-unit,
legitimacy) is tracked separately in `survey_ballots` with no linking key, so no
one — agent or board — can learn *how* a resident voted through the application.
Full mechanism in **[surveys.md](surveys.md)**; the residual direct-DB
correlation risk is in the threat model below.

## Threat model & residual risk

| Actor                              | Vector                                                                   | Mitigation                                 |
| ---------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| Managing agent                     | Browse residents' PII beyond need                                        | RBAC scope + `access_log`                  |
| Board/admin (app)                  | Read survey linkage, snoop tickets                                       | Split ballot/response tables; `access_log` |
| Outsider                           | Steal session / brute OTP                                                | [security.md](security.md)                 |
| **Board/admin (direct D1 access)** | Read tables directly, correlate ballots↔responses by row insertion order | **Accepted residual risk** — see below     |

**Accepted residual risk (explicit).** The board owns and can directly query the
D1 database. Nothing in the app can stop a determined operator with DB access
from correlating anonymised rows (e.g. by rowid insertion order) or reading PII
outside the audited API. Defending against the database owner would require
per-record client-side encryption / a separate trusted anonymisation service —
**high cost that outweighs the benefit** for a ~200-unit board-run system. We
therefore anonymise and audit at the application layer and document this ceiling
rather than engineer around it. (Consistent with D8 — don't build software
defences the operating model makes moot.)
