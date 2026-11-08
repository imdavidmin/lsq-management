// Outbound mail via MailerSend's REST API (no SDK), shared by the server and
// the ai Worker (D32). Without an API key (dev/test) it logs instead, so the OTP
// code is visible in `wrangler dev` output.
export interface MailEnv {
  MAIL_FROM: string;
  MAIL_FROM_NAME: string;
  MAILERSEND_API_KEY?: string;
}

export interface Mail {
  from?: string; // defaults to MAIL_FROM
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
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
      from: { email: mail.from ?? env.MAIL_FROM, name: env.MAIL_FROM_NAME },
      to: mail.to.map((email) => ({ email })),
      ...(mail.cc?.length ? { cc: mail.cc.map((email) => ({ email })) } : {}),
      ...(mail.replyTo ? { reply_to: { email: mail.replyTo } } : {}),
      subject: mail.subject,
      text: mail.text,
    }),
  });
  if (!res.ok) {
    console.error(`[mail] send failed ${res.status}: ${await res.text()}`);
  }
}
