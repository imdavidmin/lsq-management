// Sentry error alerts, shared by the three Workers (D38). Every console.error
// becomes an issue, so existing logging needs no changes. No DSN (dev/test) → off.
import { captureConsoleIntegration, type CloudflareOptions } from "@sentry/cloudflare";

export const sentryOptions =
  (worker: "server" | "email" | "ai") =>
  (env: { SENTRY_DSN?: string }): CloudflareOptions => ({
    dsn: env.SENTRY_DSN,
    integrations: [captureConsoleIntegration({ levels: ["error"] })],
    initialScope: { tags: { worker } },
    tracesSampleRate: 0.1,
  });
