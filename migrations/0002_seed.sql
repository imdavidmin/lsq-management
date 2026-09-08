-- Seed: roles, role permissions, metric config (from the rubric), a starter site.
-- Idempotent-ish for local re-runs via INSERT OR IGNORE where safe.

-- Roles --------------------------------------------------------------------
INSERT OR IGNORE INTO roles (key, name) VALUES
  ('resident',   'Resident'),
  ('board',      'Board Member'),
  ('agent',      'Managing Agent'),
  ('admin',      'System Admin'),
  ('contractor', 'Contractor');

-- Permissions per role. '*' = all; 'ns:*' = all in a namespace. Checked in rbac.ts.
INSERT OR IGNORE INTO role_permissions (role_key, permission) VALUES
  ('admin', '*'),
  ('board', '*'),

  ('agent', 'ticket:*'),
  ('agent', 'account:read'),
  ('agent', 'dir:read'),
  ('agent', 'org:read'),
  ('agent', 'sender:read'),
  ('agent', 'sender:manage'),
  ('agent', 'score:read'),
  ('agent', 'report:read'),
  ('agent', 'metric:read'),
  ('agent', 'metric:enter'),
  ('agent', 'survey:read'),
  ('agent', 'survey:manage'),
  ('agent', 'config:read'),

  ('resident', 'ticket:read'),
  ('resident', 'ticket:create'),
  ('resident', 'ticket:comment'),
  ('resident', 'survey:read'),
  ('resident', 'survey:respond'),
  ('resident', 'config:read');
  -- contractor: no HTTP permissions for now (interacts via email ingest).

-- Metrics: effective weight = domain% × sub-%. All rows sum to 1.0. -----------
-- domain is a display label only; its weight is SUM(weight).
INSERT OR IGNORE INTO metrics (key, domain, weight, mode, threshold, source, active) VALUES
  -- Financial Management (0.40)
  ('fin.draft_accounts',   'financial',  0.140, 'binary',       NULL, 'manual', 1), -- .40×.35
  ('fin.draft_budget',     'financial',  0.060, 'binary',       NULL, 'manual', 1), -- .40×.15
  ('fin.audit_clean',      'financial',  0.080, 'binary',       NULL, 'manual', 1), -- .40×.20
  ('fin.spend_vs_budget',  'financial',  0.120, 'binary',       NULL, 'manual', 1), -- .40×.30
  -- Governance & Administration (0.05)
  ('gov.statutory_filings','governance', 0.035, 'binary',       NULL, 'manual', 1), -- .05×.70
  ('gov.annual_meeting',   'governance', 0.015, 'binary',       NULL, 'manual', 1), -- .05×.30
  -- Site Management (0.15)
  ('site.cleanliness',     'site',       0.0375,'binary',       4.0,  'survey', 1), -- .15×.25
  ('site.cleaning_sla',    'site',       0.030, 'proportional', 0.90, 'auto',   1), -- .15×.20
  ('site.defect_origin',   'site',       0.0825,'proportional', 0.60, 'auto',   1), -- .15×.55
  -- Contractor Management (0.15)
  ('con.contractor_sla',   'contractor', 0.0525,'proportional', 0.85, 'auto',   1), -- .15×.35
  ('con.landscaping',      'contractor', 0.0375,'binary',       4.0,  'survey', 1), -- .15×.25
  ('con.hiu_servicing',    'contractor', 0.030, 'proportional', 0.85, 'manual', 1), -- .15×.20
  ('con.window_cleaning',  'contractor', 0.030, 'binary',       2.0,  'manual', 1), -- .15×.20
  -- Resident & Board Service (0.15)
  ('res.ack_sla',          'resident',   0.060, 'proportional', 0.90, 'auto',   1), -- .15×.40
  ('res.followup_sla',     'resident',   0.060, 'proportional', 0.85, 'auto',   1), -- .15×.40
  ('res.communication',    'resident',   0.030, 'binary',       4.0,  'survey', 1), -- .15×.20
  -- Projects Execution (0.10)
  ('proj.timelines',       'projects',   0.100, 'proportional', 0.95, 'manual', 1); -- .10×1.0

-- Lansbury Square physical structure. The estate as a whole is the NULL scope
-- (scope_type='estate'), so it needs no row. Residential blocks + communal
-- areas (podium/gym/parking) are buildings so tickets can name their location.
-- Units (per-flat) are added per building as real data lands, via /units.
INSERT OR IGNORE INTO buildings (id, name) VALUES
  (1, 'Colston House'),
  (2, 'Madeira Street Townhouses'),
  (3, 'Banbury Point'),
  (4, 'Lamington Heights'),
  (5, 'Chorley Court'),
  (6, 'Block G'),
  (7, 'Podium'),
  (8, 'Gym'),
  (9, 'Parking'),
  (10, 'Parkin House');

-- Site information page (markdown). Admin-editable via PUT /site-info.
INSERT OR IGNORE INTO config (key, value) VALUES
  ('site_info',
   '## Lansbury Square — Site Information

**Managing agent:** Dwellent Ltd — [managers@dwellent.example](mailto:managers@dwellent.example) · 020 7000 0000

**Out-of-hours emergencies:** 0800 000 0000

Report anything else via a ticket on this system.');
