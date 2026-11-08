import type { QueuedEmail } from "../../common/queue";
import { processInbound, type Env } from "./process";
import { triageInbound } from "./triage";

// Queue consumer: one message = one inbound email — a ticket reply, or mail to
// a triage inbox (D32). ack on success; retry on failure so a transient
// AI/DB/R2 error is retried (and dead-lettered after the queue's max_retries)
// rather than lost.
export default {
  async queue(batch: MessageBatch<QueuedEmail>, env: Env): Promise<void> {
    for (const m of batch.messages) {
      try {
        if ("inbox" in m.body) await triageInbound(env, m.body);
        else await processInbound(env, m.body);
        m.ack();
      } catch (err) {
        console.error("inbound process failed", err);
        m.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, QueuedEmail>;
