import PostalMime, { type Address } from "postal-mime";
import type { InboundEmail } from "../../common/queue";
import { primaryRole } from "../../common/roles";
import { defaultRole } from "../../common/senders";
import { ROLE_GROUPS } from "../../common/sla";
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

// HTML-only mail → readable text: drop style/script, keep block breaks, strip tags.
function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// The readable message: text part, else HTML converted; capped (D28).
const bodyOf = (email: { text?: string; html?: string }) =>
  (email.text ?? (email.html ? htmlToText(email.html) : ""))
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 10_000);

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

// To/Cc addresses (groups flattened), lowercased.
const recipients = (list: Address[]): string[] =>
  list
    .flatMap((a) => (a.group ? a.group : [a]))
    .map((m) => m.address?.toLowerCase())
    .filter((e): e is string => !!e);

// Safe R2 key segment for an attachment's filename.
const safeName = (name: string | null) => (name ?? "attachment").replace(/[^\w.-]+/g, "_").slice(0, 100) || "attachment";

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

// UJ-04: account email (primary or extra, D29) → senders email → senders domain
// → upsert unknown. Without an organization the role defaults by domain (D29).
async function resolveSender(env: Env, from: string, now: string): Promise<Attribution> {
  const account = await one<{ id: number }>(
    env.DB,
    `SELECT a.id FROM accounts a LEFT JOIN account_emails ae ON ae.account_id = a.id
      WHERE a.active = 1 AND (a.email = ? OR ae.email = ?) LIMIT 1`,
    from,
    from
  );
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
      return { actor_id: null, actor_email: from, actor_role: s.kind ? roleForKind(s.kind) : defaultRole(from) };
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
  return { actor_id: null, actor_email: from, actor_role: defaultRole(from) };
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

// Consume one queued inbound email: parse the raw message from R2, resolve the
// sender, summarise (unless opted out), then write the comment, its attachments
// and any enquiry marker in one batch (UJ-03/04/16, D28). The raw message stays
// in R2 as the comment's "original"; its row makes a queue retry a no-op.
export async function processInbound(env: Env, msg: InboundEmail): Promise<void> {
  if (await one(env.DB, "SELECT 1 FROM attachments WHERE r2_key = ?", msg.rawKey)) return; // already done

  const obj = await env.RAW.get(msg.rawKey);
  const raw = obj ? await obj.arrayBuffer() : new ArrayBuffer(0);
  const email = await PostalMime.parse(raw);
  const bodyText = bodyOf(email);

  const now = new Date().toISOString();
  // Producer lowercases already; normalise again defensively (emails are
  // case-insensitive and attribution keys off this).
  const { actor_id, actor_email, actor_role } = await resolveSender(env, msg.from.toLowerCase(), now);
  const noAi = /no ai/i.test(msg.subject); // UJ-16 opt-out
  const aiSummary = noAi ? null : await summarise(env, msg.subject, bodyText);

  // Files first, under keys derived from the raw key so a retry overwrites them.
  const rawId = msg.rawKey.slice(msg.rawKey.lastIndexOf("/") + 1);
  const files = await Promise.all(
    email.attachments.map(async (att, i) => {
      const r2Key = `attachments/${msg.ticketId}/${rawId}/${i}-${safeName(att.filename)}`;
      const content = typeof att.content === "string" ? new TextEncoder().encode(att.content) : att.content;
      await env.RAW.put(r2Key, content, { httpMetadata: { contentType: att.mimeType } });
      return { r2Key, filename: att.filename ?? safeName(null), type: att.mimeType, size: content.byteLength };
    })
  );

  // Staff emailing a contractor with the ticket in CC is the enquiry (D21, D31).
  let enquiry = false;
  if ((ROLE_GROUPS.staff as readonly string[]).includes(actor_role ?? "")) {
    for (const to of recipients([...(email.to ?? []), ...(email.cc ?? [])])) {
      if (await isContractor(env, to)) {
        enquiry = true;
        break;
      }
    }
  }

  const eventOf = `(SELECT event_id FROM attachments WHERE r2_key = ?)`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events
         (subject_type, subject_id, at, actor_id, actor_email, actor_role, type, body, source, ai_processed, ai_summary)
       VALUES ('ticket', ?, ?, ?, ?, ?, 'comment', ?, 'email', ?, ?)`
    ).bind(msg.ticketId, now, actor_id, actor_email, actor_role, bodyText, noAi ? 0 : 1, aiSummary),
    env.DB.prepare(
      `INSERT INTO attachments (event_id, kind, filename, content_type, size, r2_key)
       VALUES (last_insert_rowid(), 'original', 'original.eml', 'message/rfc822', ?, ?)`
    ).bind(raw.byteLength, msg.rawKey),
    ...files.map((f) =>
      env.DB.prepare(
        `INSERT INTO attachments (event_id, kind, filename, content_type, size, r2_key)
         VALUES (${eventOf}, 'file', ?, ?, ?, ?)`
      ).bind(msg.rawKey, f.filename, f.type, f.size, f.r2Key)
    ),
    ...(enquiry
      ? [
          env.DB.prepare(
            `INSERT INTO events (subject_type, subject_id, at, actor_id, actor_email, actor_role, type, to_value, source)
             VALUES ('ticket', ?, ?, ?, ?, ?, 'marker', 'enquiry_sent', 'email')`
          ).bind(msg.ticketId, now, actor_id, actor_email, actor_role),
        ]
      : []),
  ]);
}
