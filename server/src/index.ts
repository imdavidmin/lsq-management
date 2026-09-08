import { app } from "./app";
import type { Env } from "./env";
import { runScheduled } from "./scheduler/cron";

// The API + cron Worker. Inbound email is handled by the separate `email` and
// `ai` Workers (see /email, /ai) via a queue — email routing never hits here.
export default {
  fetch: app.fetch,

  // Daily chase + monthly report (UJ-11/12).
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    await runScheduled(env, new Date(event.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
