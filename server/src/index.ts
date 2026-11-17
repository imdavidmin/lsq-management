import * as Sentry from "@sentry/cloudflare";
import { app } from "./app";
import type { Env } from "./env";
import { runScheduled } from "./scheduler/cron";
import { sentryOptions } from "../../common/sentry";

// The API + cron Worker. Inbound email is handled by the separate `email` and
// `ai` Workers (see /email, /ai) via a queue — email routing never hits here.
export default Sentry.withSentry<Env>(sentryOptions("server"), {
  fetch: app.fetch,

  // Daily chase + monthly report (UJ-11/12). The check-in alerts if a day's run is missed (D38).
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    await Sentry.withMonitor("daily-cron", () => runScheduled(env, new Date(event.scheduledTime)), {
      schedule: { type: "crontab", value: "0 2 * * *" }, // matches wrangler.jsonc triggers
      checkinMargin: 60,
      maxRuntime: 15,
      timezone: "Etc/UTC",
    });
  },
} satisfies ExportedHandler<Env>);
