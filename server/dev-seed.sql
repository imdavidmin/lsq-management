-- Dev-only demo data for local testing. Idempotent (fixed PKs + INSERT OR IGNORE).
-- Apply: npm run seed:dev  (after migrate:local). Never applied to remote.

-- Units --------------------------------------------------------------------
-- Buildings are seeded by migrations/0002_seed.sql (the single source of truth);
-- these units hang off building ids 1 & 2 (Colston House, Madeira Street).
INSERT OR IGNORE INTO units (id, building_id, label) VALUES
  (1, 1, 'Flat 1'), (2, 1, 'Flat 2'), (3, 1, 'Flat 3'),
  (4, 2, 'Flat 12'), (5, 2, 'Flat 14');

-- Accounts & grants (ids 10+ to avoid the dev-login account at id 1) ----------
INSERT OR IGNORE INTO accounts (id, email, name) VALUES
  (10, 'alice@lansburysquare.co.uk', 'Alice Chen'),
  (11, 'bob@example.com',            'Bob Taylor'),
  (12, 'carol@example.com',          'Carol Diaz'),
  (13, 'dave@dwellent.com',          'Dave Morgan');
INSERT OR IGNORE INTO grants (id, account_id, role_key, scope_type, scope_id) VALUES
  (10, 10, 'board',    'estate', NULL),
  (11, 11, 'resident', 'unit',   1),
  (12, 12, 'resident', 'unit',   4),
  (13, 13, 'agent',    'estate', NULL);

-- Organizations & senders (incl. unknown-sender queue, UJ-07) -----------------
INSERT OR IGNORE INTO organizations (id, name, kind) VALUES
  (1, 'Dwellent Managing Agents', 'agent'),
  (2, 'GreenScape Landscaping',   'contractor'),
  (3, 'AquaHeat HIU Services',    'contractor');
INSERT OR IGNORE INTO senders (id, match_type, match_value, org_id, status, hit_count, first_seen, last_seen) VALUES
  (1, 'email',  'dave@dwellent.com',   1,    'linked', 5, '2026-06-01T09:00:00Z', '2026-08-18T14:00:00Z'),
  (2, 'domain', 'windowshine.co.uk',   NULL, 'new',    3, '2026-08-10T08:30:00Z', '2026-08-19T11:00:00Z'),
  (3, 'email',  'contact@spam.co',     NULL, 'new',    1, '2026-08-20T07:15:00Z', '2026-08-20T07:15:00Z');

-- Tickets ---------------------------------------------------------------------
INSERT OR IGNORE INTO tickets (id, title, building_id, unit_id, created_by, category, classified_by, needs_contractor, status, created_at, resolved_at, closed_at) VALUES
  (1, 'Broken light in lobby',        1, NULL, 11, 'site_defect',    'agent', 0, 'open',              '2026-08-15T09:12:00Z', NULL, NULL),
  (2, 'Leaking tap in Flat 1',        1, 1,    11, 'reactive_fault', 'agent', 1, 'pending_3rd_party', '2026-08-14T16:40:00Z', NULL, NULL),
  (3, 'Bins not collected',           2, NULL, 12, 'cleaning',       'agent', 0, 'resolved',          '2026-08-10T07:05:00Z', '2026-08-12T10:00:00Z', NULL),
  (4, 'Lift out of service',          2, NULL, 12, 'reactive_fault', 'board', 1, 'open',              '2026-08-19T18:22:00Z', NULL, NULL),
  (5, 'Graffiti on stairwell',        1, NULL, 11, 'site_defect',    'agent', 0, 'closed',            '2026-07-28T12:00:00Z', '2026-08-01T09:00:00Z', '2026-08-05T09:00:00Z'),
  (6, 'Cracked path near entrance',   1, NULL, 11, 'site_defect',    'agent', 0, 'open',              '2026-07-18T10:00:00Z', NULL, NULL);

-- Ticket events (timeline) ----------------------------------------------------
INSERT OR IGNORE INTO events (id, subject_type, subject_id, at, actor_id, actor_role, type, from_value, to_value, body, source) VALUES
  (1, 'ticket', 1, '2026-08-15T09:12:00Z', 11, 'resident', 'comment',  NULL,   NULL,               'The lobby ceiling light has been out for two days.', 'ui'),
  (2, 'ticket', 1, '2026-08-15T09:13:00Z', NULL,'system',   'classify', NULL,   'site_defect',      NULL, 'ui'),
  (3, 'ticket', 2, '2026-08-14T16:40:00Z', 11, 'resident', 'comment',  NULL,   NULL,               'Kitchen tap dripping constantly.', 'ui'),
  (4, 'ticket', 2, '2026-08-15T08:00:00Z', 13, 'agent',    'status',   'open', 'pending_3rd_party','Plumber booked for Thursday.', 'ui'),
  (5, 'ticket', 3, '2026-08-10T07:05:00Z', 12, 'resident', 'comment',  NULL,   NULL,               'Recycling bins still full since Monday.', 'ui'),
  (6, 'ticket', 3, '2026-08-12T10:00:00Z', 13, 'agent',    'status',   'open', 'resolved',         'Collection completed and confirmed.', 'ui'),
  (7, 'ticket', 4, '2026-08-19T18:22:00Z', 12, 'resident', 'comment',  NULL,   NULL,               'Lift stuck on ground floor, not responding.', 'ui'),
  (8, 'ticket', 5, '2026-07-28T12:00:00Z', 11, 'resident', 'comment',  NULL,   NULL,               'Graffiti on the second-floor stairwell wall.', 'ui'),
  (9, 'ticket', 5, '2026-08-05T09:00:00Z', 10, 'board',    'status',   'resolved','closed',        'Cleaned and closed.', 'ui'),
  (10,'ticket', 6, '2026-07-20T09:00:00Z', 11, 'resident', 'comment',  NULL,   NULL,               'Paving slab cracked by the main door — trip hazard.', 'ui');

-- Manual metric values (service_year 2026): some attested, some pending --------
INSERT OR IGNORE INTO metric_values (id, metric_key, service_year, value, result, entered_by, attested_by, computed_at, notes) VALUES
  (1, 'fin.draft_accounts', 2026, 1,   1.0,  10, 10,   '2026-08-01T10:00:00Z', 'Draft accounts delivered on time.'),
  (2, 'fin.draft_budget',   2026, 1,   1.0,  10, NULL, '2026-08-02T10:00:00Z', 'Awaiting board attestation.'),
  (3, 'fin.audit_clean',    2026, 1,   1.0,  10, 10,   '2026-08-01T10:05:00Z', NULL),
  (4, 'con.window_cleaning',2026, 3,   1.0,  10, NULL, '2026-08-03T09:00:00Z', 'Quarterly clean count met.'),
  (5, 'con.hiu_servicing',  2026, 0.9, 1.0,  10, 10,   '2026-08-03T09:10:00Z', NULL),
  (6, 'proj.timelines',     2026, 0.9, 0.95, 10, NULL, '2026-08-04T15:00:00Z', 'Two of three projects on schedule.');

-- Surveys & responses (open 2026 survey; a few responses, one outlier) --------
INSERT OR IGNORE INTO surveys (id, service_year, opened_at, closed_at) VALUES
  (1, 2025, '2025-06-01T00:00:00Z', '2025-09-01T00:00:00Z'),
  (2, 2026, '2026-06-01T00:00:00Z', NULL);
INSERT OR IGNORE INTO survey_responses (id, survey_id, answers, is_outlier, submitted_on) VALUES
  (1, 2, '{"cleanliness":5,"landscaping":4,"communication":5}', 0, '2026-06-10'),
  (2, 2, '{"cleanliness":4,"landscaping":4,"communication":3}', 0, '2026-06-11'),
  (3, 2, '{"cleanliness":5,"landscaping":5,"communication":4}', 0, '2026-06-12'),
  (4, 2, '{"cleanliness":3,"landscaping":2,"communication":3}', 0, '2026-06-14'),
  (5, 2, '{"cleanliness":1,"landscaping":1,"communication":1}', 1, '2026-06-15'),
  (6, 2, '{"cleanliness":4,"landscaping":5,"communication":4}', 0, '2026-06-18');

