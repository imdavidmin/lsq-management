-- Seed: roles, role permissions, metric config + SLAs (from the rubric), a starter site.
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
  ('agent', 'sla:read'),             -- the SLAs they're measured against

  ('resident', 'ticket:read'),
  ('resident', 'ticket:create'),
  ('resident', 'ticket:comment'),
  ('resident', 'survey:read'),
  ('resident', 'survey:respond'),
  ('resident', 'config:read');
  -- contractor: no HTTP permissions for now (interacts via email ingest).

-- Metrics: effective weight = domain% × sub-%. All rows sum to 1.0. -----------
-- domain is a display label only; its weight is SUM(weight).
INSERT OR IGNORE INTO metrics (key, domain, weight, mode, threshold, source, active, description) VALUES
  -- Financial Management (0.40)
  ('fin.service_charge_accounts',   'financial',  0.140, 'binary',       NULL, 'manual', 1, 'Draft service charge accounts sent to the Board within 4 calendar months of the financial year end.'), -- .40×.35
  ('fin.service_charge_budget',     'financial',  0.060, 'binary',       NULL, 'manual', 1, 'Draft service charge budget circulated at least 2 calendar months before the new service charge year.'), -- .40×.15
  ('fin.external_audit',            'financial',  0.080, 'binary',       NULL, 'manual', 1, 'The Board-appointed external auditor confirms any required adjustments are not material and show no systemic deficiency in the agent''s accounting processes.'), -- .40×.20
  ('fin.operational_spend',         'financial',  0.120, 'binary',       NULL, 'manual', 1, 'Operational spend vs budget: adjusted total within +5% of the approved budget, and no single heading over +10% without prior Board approval. Board-approved extraordinary spend that could not reasonably be forecast is excluded.'), -- .40×.30
  -- Governance & Administration (0.05)
  ('gov.statutory_filings',         'governance', 0.035, 'binary',       NULL, 'manual', 1, 'All statutory administrative filings filed by their deadline.'), -- .05×.70
  ('gov.annual_resident_meeting',   'governance', 0.015, 'binary',       NULL, 'manual', 1, 'Annual resident meeting held with at least 21 days'' notice and no more than 1 month before the start of the next service charge year.'), -- .05×.30
  -- Site Management (0.15)
  ('site.cleanliness',              'site',       0.0375,'binary',       4.0,  'survey', 1, 'Cleanliness rating in the resident survey. Applies only once at least 50 responses are received, excluding outliers at the Board''s discretion.'), -- .15×.25
  ('site.cleaning_tickets',         'site',       0.030, 'proportional', 0.90, 'auto',   1, 'Cleaning request tickets resolved on time (per the cleaning contractor''s on-site schedule).'), -- .15×.20
  ('site.site_inspection',          'site',       0.0825,'proportional', 0.60, 'auto',   1, 'Share of site-inspection defect tickets in scope that were raised by staff. Excludes duplicates, damage caused by the reporter, sudden reactive faults (power outage, burst pipes), out-of-hours criminal damage, and cleaning tickets.'), -- .15×.55
  -- Contractor Management (0.15)
  ('con.contractor_attendance',     'contractor', 0.0525,'proportional', 0.85, 'auto',   1, 'Defect tickets needing off-site contractor attendance where all of these are met: prompt initial enquiry to the contractor; where the agent is expected to respond, a prompt reply; if the contractor doesn''t respond, a prompt follow-up; after each contractor attendance, a prompt ticket update with the outcome and next action.'), -- .15×.35
  ('con.landscaping',               'contractor', 0.0375,'binary',       4.0,  'survey', 1, 'Landscaping rating in the resident survey. Applies only once at least 50 responses are received, excluding outliers at the Board''s discretion.'), -- .15×.25
  ('con.hiu_servicing',             'contractor', 0.030, 'proportional', 0.85, 'manual', 1, 'HIU servicing completed within the service year.'), -- .15×.20
  ('con.window_cleaning',           'contractor', 0.030, 'binary',       2.0,  'manual', 1, 'Window cleaning performed on the estate in the service year.'), -- .15×.20
  -- Resident & Board Service (0.15)
  ('res.ticket_acknowledgement',    'resident',   0.060, 'proportional', 0.90, 'auto',   1, 'Tickets acknowledged on time.'), -- .15×.40
  ('res.third_party_follow_up',     'resident',   0.060, 'proportional', 0.85, 'auto',   1, 'Tickets requiring follow-up pending a 3rd party that have an actioned update on time.'), -- .15×.40
  ('res.communication',             'resident',   0.030, 'binary',       4.0,  'survey', 1, 'Communication rating in the resident survey. Applies only once at least 50 responses are received, excluding outliers at the Board''s discretion.'), -- .15×.20
  -- Projects Execution (0.10)
  ('proj.project_timelines',        'projects',   0.100, 'proportional', 0.95, 'manual', 1, 'Self-published project timeline targets met.'); -- .10×1.0

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

-- Scoring settings: service_year_start is MM-DD (a year is labelled by the
-- calendar year it starts in) (D21).
INSERT OR IGNORE INTO config (key, value) VALUES
  ('service_year_start', '08-01');

-- SLAs (D21), seeded from the rubric; traces in docs/plan/plan-scoring-sla.md.
INSERT INTO slas (name, metric_key, category, needs_contractor, start_on, start_value, stop_on, stop_value, budget_days, repeats, description) VALUES
  ('Cleaning resolved',       'site.cleaning_tickets',       'cleaning', NULL, 'ticket_created', NULL,                  'status',   'resolved',     1, 0, 'Cleaning request tickets resolved, counted against the cleaning contractor''s on-site schedule.'),
  ('Acknowledged',            'res.ticket_acknowledgement',  NULL,       NULL, 'ticket_created', NULL,                  'event_by', 'staff',        2, 0, 'Tickets acknowledged by the agent.'),
  ('3rd-party follow-up',     'res.third_party_follow_up',   NULL,       NULL, 'status',         'pending_3rd_party',   'event_by', 'staff',        5, 1, 'Tickets requiring follow-up pending a 3rd party have an actioned update, each time they go pending.'),
  ('Enquiry to contractor',   'con.contractor_attendance',   NULL,       1,    'ticket_created', NULL,                  'marker',   'enquiry_sent', 2, 0, 'Initial enquiry to the contractor after the ticket is raised.'),
  ('Reply to contractor',     'con.contractor_attendance',   NULL,       1,    'event_by',       'contractor',          'event_by', 'staff',        2, 1, 'Where an agent response is expected, the agent replies to the contractor.'),
  ('Chase silent contractor', 'con.contractor_attendance',   NULL,       1,    'marker',         'enquiry_sent',        'event_by', 'staff',        6, 1, 'After each enquiry, the agent follows up within 6 working days, so the contractor thread doesn''t go cold.'),
  ('Update after attendance', 'con.contractor_attendance',   NULL,       1,    'marker',         'attended',            'event_by', 'staff',        2, 1, 'After each contractor attendance, the ticket is updated with the outcome and next action.');
