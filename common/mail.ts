/// <reference path="./email-templates/html.d.ts" />
// Outbound mail via MailerSend's REST API (no SDK), shared by the server and
// the ai Worker (D32). Without an API key (dev/test) it logs instead, so the OTP
// code is visible in `wrangler dev` output. HTML goes alongside text (D35).
import layoutHtml from "./email-templates/layout.html";
import otp from "./email-templates/otp.html";
import invite from "./email-templates/invite.html";
import comment from "./email-templates/comment.html";
import ticketDigest from "./email-templates/ticket-digest.html";
import ticketDigestRow from "./email-templates/ticket-digest-row.html";
import triageBanner from "./email-templates/triage-banner.html";
export interface MailEnv {
  MAIL_FROM: string;
  MAIL_FROM_NAME: string;
  APP_URL: string; // live site: logo + ticket links in mail
  MAILERSEND_API_KEY?: string;
}

export interface Mail {
  from?: string; // defaults to MAIL_FROM
  fromName?: string; // defaults to MAIL_FROM_NAME
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendMail(env: MailEnv, mail: Mail): Promise<void> {
  if (!env.MAILERSEND_API_KEY) {
    console.log(`[mail:dev] to=${mail.to.join(",")} cc=${mail.cc?.join(",") ?? ""} subject=${mail.subject}\n${mail.text}`);
    return;
  }
  const res = await fetch("https://api.mailersend.com/v1/email", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MAILERSEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: { email: mail.from ?? env.MAIL_FROM, name: mail.fromName ?? env.MAIL_FROM_NAME },
      to: mail.to.map((email) => ({ email })),
      ...(mail.cc?.length ? { cc: mail.cc.map((email) => ({ email })) } : {}),
      ...(mail.replyTo ? { reply_to: { email: mail.replyTo } } : {}),
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
    }),
  });
  if (!res.ok) {
    console.error(`[mail] send failed ${res.status}: ${await res.text()}`);
  }
}

// HTML parts live in email-templates/ (D35): {{x}} is escaped, {{{x}}} is
// HTML the caller already built (escaped). Inline styles only: mail clients drop <style>.
const TEMPLATES = {
  otp,
  invite,
  comment,
  "ticket-digest": ticketDigest,
  "ticket-digest-row": ticketDigestRow,
  "triage-banner": triageBanner,
};

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fill = (html: string, vars: Record<string, string | number>) =>
  html.replace(/\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g, (_, raw?: string, safe?: string) =>
    raw ? String(vars[raw] ?? "") : esc(String(vars[safe!] ?? ""))
  );

export const render = (name: keyof typeof TEMPLATES, vars: Record<string, string | number>) => fill(TEMPLATES[name], vars);

// Plain text → paragraphs, keeping single line breaks.
export const paragraphs = (text: string) =>
  text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

// Logo header, white card, footer around already-built HTML.
export const layout = (env: MailEnv, content: string) =>
  fill(layoutHtml, { app_url: env.APP_URL, site_name: env.MAIL_FROM_NAME, content });
