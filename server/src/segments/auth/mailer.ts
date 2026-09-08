import type { Env } from "../../env";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

// MailerSend via REST (no SDK). Without an API key (dev/test) it logs instead,
// so the OTP code is visible in `wrangler dev` output.
export async function sendMail(env: Env, mail: Mail): Promise<void> {
  if (!env.MAILERSEND_API_KEY) {
    console.log(`[mail:dev] to=${mail.to} subject=${mail.subject}\n${mail.text}`);
    return;
  }
  const res = await fetch("https://api.mailersend.com/v1/email", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MAILERSEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: { email: env.MAIL_FROM },
      to: [{ email: mail.to }],
      subject: mail.subject,
      text: mail.text,
    }),
  });
  if (!res.ok) {
    console.error(`[mail] send failed ${res.status}: ${await res.text()}`);
  }
}
