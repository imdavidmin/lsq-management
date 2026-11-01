import type { InboundEmail } from "../../common/queue";
import { primaryRole } from "../../common/roles";
import { all, one, run } from "./db";

export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  AI?: Ai; // absent in tests/dev → summary skipped, event still recorded
}

const MODEL = "@cf/facebook/bart-large-cnn"; // summarisation

interface Attribution {
  actor_id: number | null;
  actor_email: string | null;
  actor_role: string | null;
}

// Best-effort plaintext body: split headers from body at the first blank line.
// ponytail: naive MIME (no multipart / base64 / quoted-printable). Add
// postal-mime if the trial shows real mail needs it; threading never depends on
// this (the email Worker resolved the ticket by recipient address already).
function extractText(raw: string): string {
  const split = raw.search(/\r?\n\r?\n/);
  const body = split >= 0 ? raw.slice(split).trimStart() : raw;
  return body.trim().slice(0, 10_000);
}

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

// Addresses in the To/Cc headers (folded lines joined), lowercased.
function recipients(raw: string): string[] {
  const split = raw.search(/\r?\n\r?\n/);
  const headers = (split >= 0 ? raw.slice(0, split) : raw).replace(/\r?\n[ \t]+/g, " ");
  const lines = headers.split(/\r?\n/).filter((l) => /^(to|cc):/i.test(l));
  return lines.flatMap((l) => l.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []).map((e) => e.toLowerCase());
}

// A contractor by sender rule, email before domain (same precedence as resolveSender).
async function isContractor(env: Env, email: string): Promise<boolean> {
  const rule = await one<{ kind: string | null }>(
    env.DB,
    `SELECT o.kind FROM senders s LEFT JOIN organizations o ON o.id = s.org_id
       WHERE s.status != 'ignored' AND ((s.match_type = 'email' AND s.match_value = ?) OR (s.match_type = 'domain' AND s.match_value = ?))
       ORDER BY s.match_type = 'email' DESC LIMIT 1`,
    email,
    domainOf(email)
  );
  return rule?.kind === "contractor";
}

// UJ-04: accounts email → senders email → senders domain → upsert unknown.
async function resolveSender(env: Env, from: string, now: string): Promise<Attribution> {
  const account = await one<{ id: number }>(env.DB, "SELECT id FROM accounts WHERE email = ? AND active = 1", from);
  if (account) {
    const grants = await all<{ role_key: string }>(env.DB, "SELECT role_key FROM grants WHERE account_id = ?", account.id);
    return { actor_id: account.id, actor_email: null, actor_role: grants.length ? primaryRole(grants) : "resident" };
  }

  const roleForKind = (kind: string) => (kind === "agent" ? "agent" : "contractor");
  for (const [type, value] of [
    ["email", from],
    ["domain", domainOf(from)],
  ] as const) {
    const s = await one<{ id: number; org_id: number | null; kind: string | null }>(
      env.DB,
      `SELECT s.id, s.org_id, o.kind FROM senders s LEFT JOIN organizations o ON o.id = s.org_id
         WHERE s.match_type = ? AND s.match_value = ? AND s.status != 'ignored'`,
      type,
      value
    );
    if (s) {
      await run(env.DB, "UPDATE senders SET hit_count = hit_count + 1, last_seen = ? WHERE id = ?", now, s.id);
      return { actor_id: null, actor_email: from, actor_role: s.kind ? roleForKind(s.kind) : null };
    }
  }

  // Unknown: log/bump the specific email for the UJ-07 queue.
  await run(
    env.DB,
    `INSERT INTO senders (match_type, match_value, org_id, status, hit_count, first_seen, last_seen)
       VALUES ('email', ?, NULL, 'new', 1, ?, ?)
     ON CONFLICT(match_value) DO UPDATE SET hit_count = hit_count + 1, last_seen = ?`,
    from,
    now,
    now,
    now
  );
  return { actor_id: null, actor_email: from, actor_role: null };
}

async function summarise(env: Env, subject: string, body: string): Promise<string | null> {
  if (!env.AI) return null;
  try {
    const res = (await env.AI.run(MODEL, { input_text: `${subject}\n\n${body}`, max_length: 120 })) as {
      summary?: string;
    };
    return res.summary ?? null;
  } catch {
    return null;
  }
}

// Consume one queued inbound email: fetch its raw body from R2, resolve the
// sender, summarise (unless opted out), and append the comment event (UJ-03/04/16).
export async function processInbound(env: Env, msg: InboundEmail): Promise<void> {
  const obj = await env.RAW.get(msg.rawKey);
  const raw = obj ? await obj.text() : "";
  const bodyText = extractText(raw);

  const now = new Date().toISOString();
  // Producer lowercases already; normalise again defensively (emails are
  // case-insensitive and attribution keys off this).
  const { actor_id, actor_email, actor_role } = await resolveSender(env, msg.from.toLowerCase(), now);
  const noAi = /no ai/i.test(msg.subject); // UJ-16 opt-out
  const aiSummary = noAi ? null : await summarise(env, msg.subject, bodyText);

  await run(
    env.DB,
    `INSERT INTO events
       (subject_type, subject_id, at, actor_id, actor_email, actor_role, type, body, source, ai_processed, ai_summary)
     VALUES ('ticket', ?, ?, ?, ?, ?, 'comment', ?, 'email', ?, ?)`,
    msg.ticketId,
    now,
    actor_id,
    actor_email,
    actor_role,
    bodyText,
    noAi ? 0 : 1,
    aiSummary
  );

  // An agent emailing a contractor with the ticket in CC is the enquiry (D21).
  if (actor_role === "agent") {
    for (const to of recipients(raw)) {
      if (!(await isContractor(env, to))) continue;
      await run(
        env.DB,
        `INSERT INTO events (subject_type, subject_id, at, actor_id, actor_email, actor_role, type, to_value, source)
         VALUES ('ticket', ?, ?, ?, ?, 'agent', 'marker', 'enquiry_sent', 'email')`,
        msg.ticketId,
        now,
        actor_id,
        actor_email
      );
      break;
    }
  }

  await env.RAW.delete(msg.rawKey); // processed → drop the raw copy
}
