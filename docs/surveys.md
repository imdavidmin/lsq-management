# Survey Mechanism

Surveys feed the **Resident & Board satisfaction** domain of the managing
agent's performance fee (see [requirements.md](requirements.md) scoring rubric).
Because a survey result can move money, it must be **fairly executed and
tamper-evident**: authorised voters only, one vote per unit, anonymous results,
and a transparent gate before the score counts. This doc is the single source
for how that works; anonymity rationale/residual risk lives in
[gdpr.md](gdpr.md).

## Principles

1. **One vote per unit — not per person.** A unit is the stakeholder in the
   estate; a household with three residents does not outweigh a single-occupant
   unit. The first eligible resident of a unit to submit consumes that unit's
   vote.
2. **Authorised only.** No unauthenticated path. The voter must be an active
   account holding an eligible-resident grant on the unit being voted for.
3. **Anonymous results.** The stored answer carries no identity; participation is
   tracked separately (see below and [gdpr.md](gdpr.md)).
4. **Gated before scoring.** A survey metric stays `pending` until enough
   non-outlier responses exist, so a handful of votes can't swing the fee.

## Data model

| Table              | Holds                                                  | Enforces                                                                              |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `surveys`          | service year, `opened_at`, `closed_at`                 | the voting window                                                                     |
| `survey_ballots`   | `(survey_id, unit_id, account_id, voted_on)`           | **PK `(survey_id, unit_id)`** = one vote per unit; `account_id` = who cast it (audit) |
| `survey_responses` | `(survey_id, answers, submitted_on)` — **no identity** | the anonymous result                                                                  |

## Submit flow (`POST /surveys/{id}/responses`, UJ-13)

Authenticated request. Identity is used to gate and stamp the ballot, then
deliberately not written onto the answer row:

```
1. authz: survey is open; caller is an active account with an eligible-resident
          grant on the target unit.                                  else 403
   unit: use unit_id from the body; if omitted and the caller has exactly one
         eligible unit, infer it; if several, 400 (must choose).
2. BEGIN
     INSERT INTO survey_ballots (survey_id, unit_id, account_id, voted_on)
     -- PK (survey_id, unit_id): second attempt for the unit fails → ROLLBACK, 409
     INSERT INTO survey_responses (survey_id, answers, submitted_on)   -- no identity
   COMMIT
```

- **Non-resident / wrong unit** → rejected at step 1.
- **Unit already voted** (by anyone in it) → 409, nothing written.
- **Anonymous at rest** → the response row has no `account_id`/`unit_id`; only the
  ballot knows the unit voted. Timestamps are date-only so the two can't be
  correlated by timing. (In-memory correlation during the request is an accepted
  ceiling — [gdpr.md](gdpr.md).)

## Answers

`answers` is a JSON map of question key → integer 1–5 (Likert). Validated on
submit. The question set is fixed per survey.

## Outliers (`PATCH /surveys/{id}/responses/{rid}`, UJ-14)

The board can flag a **response row** (by its values, never by person) as an
outlier to exclude it from scoring — e.g. an all-1s or all-5s protest vote.
Flagging is itself an audited action and is visible in the response list, so
exclusions can be challenged. Flagging identity-blind keeps the board from
targeting a known individual's vote.

## Scoring gate

A survey-sourced metric returns `pending` (does not count toward the fee) until
it has **≥ N non-outlier responses** (default N = 50; configurable). Once met,
the metric scores from the mean of non-outlier answers via the metric's
`mode`/`threshold` like any other. The `pending`/met state and the counts
(total, non-outlier, threshold) are exposed on `/score` so both board and agent
can see whether a domain is live and why.

## Lifecycle

Open (`opened_at`) → collect responses → optional outlier flagging → close
(`closed_at`). A closed survey rejects new responses. Fairness levers — window
length, threshold N, question set — are configuration, recorded per survey, not
code.
