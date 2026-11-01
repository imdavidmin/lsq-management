-- LSQ site-operations system — D1 schema. Design rationale in docs/.
-- The annotated data-model reference; seed data lives in 0002_seed.sql.

------------------------------------------------------------------- identity ---

-- Physical structure; a building is also a resident scope/audience.
CREATE TABLE buildings (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL
);
CREATE TABLE units (
  id           INTEGER PRIMARY KEY,
  building_id  INTEGER NOT NULL REFERENCES buildings(id),
  label        TEXT NOT NULL                 -- e.g. 'Flat 12'
);

-- Identity only; role/scope/residence/board are grants.
CREATE TABLE accounts (
  id      INTEGER PRIMARY KEY,
  email   TEXT UNIQUE NOT NULL,
  name    TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1
);

-- Roles as data.
CREATE TABLE roles (
  key   TEXT PRIMARY KEY,            -- 'resident','board','agent','admin','contractor'
  name  TEXT NOT NULL
);

-- Privileges as data: permission strings per role.
CREATE TABLE role_permissions (
  role_key    TEXT NOT NULL REFERENCES roles(key),
  permission  TEXT NOT NULL,                 -- e.g. 'ticket:read','metric:enter'
  PRIMARY KEY (role_key, permission)
);

-- An account holds a role scoped to a thing; the single association+access table.
CREATE TABLE grants (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  role_key    TEXT NOT NULL REFERENCES roles(key),
  scope_type  TEXT NOT NULL CHECK (scope_type IN
                ('estate','building','unit','organization','ticket')),
  scope_id    INTEGER                        -- NULL only when scope_type='estate'
);
CREATE INDEX idx_grants_account ON grants(account_id);
CREATE INDEX idx_grants_scope   ON grants(scope_type, scope_id);

-- Companies we transact with (agent + contractors).
CREATE TABLE organizations (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  kind  TEXT NOT NULL CHECK (kind IN ('agent','contractor'))
);

-- Inbound sender mapping + unknown-sender log; org_id NULL = unknown.
CREATE TABLE senders (
  id          INTEGER PRIMARY KEY,
  match_type  TEXT NOT NULL CHECK (match_type IN ('email','domain')),
  match_value TEXT UNIQUE NOT NULL,           -- 'joe@acme.com' or 'acme.com'
  org_id      INTEGER REFERENCES organizations(id),
  status      TEXT NOT NULL DEFAULT 'new'
              CHECK (status IN ('new','ignored','linked')),
  hit_count   INTEGER NOT NULL DEFAULT 1,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);

----------------------------------------------------------------------- auth ---

-- Passwordless login codes; hashed, short TTL, single-use, attempt-capped.
CREATE TABLE otp_codes (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,                     -- set on use; blocks reuse
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_otp_account ON otp_codes(account_id, expires_at);

-- Server-side sessions; expires_at slides up to hard_expires_at, delete to revoke.
CREATE TABLE sessions (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES accounts(id),
  token_hash      TEXT UNIQUE NOT NULL,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL,        -- sliding
  hard_expires_at TEXT NOT NULL         -- absolute cap
);
CREATE INDEX idx_sessions_account ON sessions(account_id);

-------------------------------------------------------------------- tickets ---

-- Ticket id IS the email address <id>@lansburysquare.co.uk.
CREATE TABLE tickets (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  building_id   INTEGER REFERENCES buildings(id),
  unit_id       INTEGER REFERENCES units(id),  -- NULL: communal
  created_by    INTEGER REFERENCES accounts(id),
  category      TEXT,                         -- site_defect|cleaning|reactive_fault|...
  classified_by TEXT NOT NULL DEFAULT 'resident'
                CHECK (classified_by IN ('resident','agent','board','admin')),
  needs_contractor INTEGER NOT NULL DEFAULT 0,
  is_duplicate  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','pending_3rd_party','resolved','closed')),
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  closed_at     TEXT
);

-- Audit spine: every update is one immutable row, for ANY subject — not just
-- tickets. subject_type/subject_id is a polymorphic reference: 'ticket' today,
-- 'metric_value' (board attestations/disputes) and others later, with no schema
-- change. No DB-level FK on subject_id (it points at different tables by
-- subject_type); the app validates the referent.
-- ponytail: polymorphic ref, app-enforced integrity — the standard audit-log
-- shape. Add a typed FK only if one subject table ever dominates enough to want it.
CREATE TABLE events (
  id           INTEGER PRIMARY KEY,
  subject_type TEXT NOT NULL DEFAULT 'ticket',  -- 'ticket' | 'sla' | 'score' (id = year) | ...
  subject_id   INTEGER,                          -- id within subject_type; NULL = system-wide event
  at           TEXT NOT NULL,
  actor_id     INTEGER REFERENCES accounts(id), -- null if unknown email
  actor_email  TEXT,                            -- raw From when actor unknown
  actor_role   TEXT,                            -- resident|agent|admin|contractor|system
  type         TEXT NOT NULL,                   -- comment|classify|status|marker|config|attest|chase|snapshot
  from_value   TEXT,
  to_value     TEXT,
  body         TEXT,
  source       TEXT NOT NULL,                   -- ui|email|ai|system
  ai_processed INTEGER NOT NULL DEFAULT 0,      -- 0 when subject had "no ai"
  ai_summary   TEXT
);
CREATE INDEX idx_events_subject ON events(subject_type, subject_id, at);

-- Key/value site config, admin-editable. `site_info` holds the estate
-- contact-details markdown; `service_year_start` (MM-DD) and
-- `contractor_reply_days` drive scoring (D21).
CREATE TABLE config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                    -- markdown
  updated_at TEXT,
  updated_by INTEGER REFERENCES accounts(id)
);

-------------------------------------------------------------------- scoring ---

-- One row per sub-metric; weights sum to 1.0. Fee = Σ (weight × result).
CREATE TABLE metrics (
  key       TEXT PRIMARY KEY,                 -- '<domain prefix>.<name>', see requirements.md
  domain    TEXT NOT NULL,                    -- display label only; fixed by the key prefix
  weight    REAL NOT NULL,                    -- effective global weight
  mode      TEXT NOT NULL CHECK (mode IN ('binary','proportional')),
  threshold REAL,
  source    TEXT NOT NULL,                    -- auto|manual|survey
  active    INTEGER NOT NULL DEFAULT 1,
  description TEXT                            -- optional, free text
);

-- auto = computed on read; manual/survey = entered; latest per (key,year) wins.
CREATE TABLE metric_values (
  id          INTEGER PRIMARY KEY,
  metric_key  TEXT NOT NULL REFERENCES metrics(key),
  service_year INTEGER NOT NULL,
  value       REAL NOT NULL,                  -- raw measured value
  result      REAL NOT NULL,                  -- 0..1 after mode+threshold
  entered_by  INTEGER REFERENCES accounts(id),-- null for auto
  attested_by INTEGER REFERENCES accounts(id),-- board sign-off
  computed_at TEXT NOT NULL,
  notes       TEXT
);
CREATE INDEX idx_metricval ON metric_values(metric_key, service_year, computed_at);

-- SLA definitions (D21): evaluated on read against ticket events; never stored
-- per ticket. Kinds/values follow common/sla.ts; seeded in 0002_seed.sql.
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
  active           INTEGER NOT NULL DEFAULT 1,
  description      TEXT                  -- optional, free text
);

-------------------------------------------------------------------- surveys ---

CREATE TABLE surveys (
  id           INTEGER PRIMARY KEY,
  service_year INTEGER NOT NULL,
  opened_at    TEXT NOT NULL,
  closed_at    TEXT
);

-- One ballot per UNIT (not per person): the first eligible resident of a unit to
-- vote consumes that unit's ballot. Holds NO answer content. See docs/surveys.md.
CREATE TABLE survey_ballots (
  survey_id  INTEGER NOT NULL REFERENCES surveys(id),
  unit_id    INTEGER NOT NULL REFERENCES units(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id), -- resident who cast it (audit)
  voted_on   TEXT NOT NULL,                            -- date only (coarsened)
  PRIMARY KEY (survey_id, unit_id)
);

-- Anonymous answers: NO account_id, so a response can't be joined to a voter.
-- ≥50 non-outlier responses gate survey metrics.
CREATE TABLE survey_responses (
  id           INTEGER PRIMARY KEY,
  survey_id    INTEGER NOT NULL REFERENCES surveys(id),
  answers      TEXT NOT NULL,                      -- JSON {cleanliness:5,...}
  is_outlier   INTEGER NOT NULL DEFAULT 0,         -- board-flagged exclusion
  submitted_on TEXT NOT NULL                       -- date only, coarsened vs ballot
);

-- PII read-access audit (GDPR): who viewed/exported which PII-bearing record.
-- Append-only. ponytail: written only on PII-bearing reads, not every request.
CREATE TABLE access_log (
  id            INTEGER PRIMARY KEY,
  at            TEXT NOT NULL,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  action        TEXT NOT NULL,                     -- view|list|export
  resource_type TEXT NOT NULL,                     -- ticket|account|directory|survey
  resource_id   TEXT,                              -- null for a list/search
  detail        TEXT                               -- optional JSON: filters, fields
);
CREATE INDEX idx_access_log ON access_log(at);
CREATE INDEX idx_access_log_resource ON access_log(resource_type, resource_id);
