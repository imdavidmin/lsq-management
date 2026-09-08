import type { InboundEmail } from "../../common/queue";
import { processInbound, type Env } from "./process";

// Queue consumer: one message = one inbound email. ack on success; retry on
// failure so a transient AI/DB/R2 error is retried (and dead-lettered after the
// queue's max_retries) rather than lost.
export default {
  async queue(batch: MessageBatch<InboundEmail>, env: Env): Promise<void> {
    for (const m of batch.messages) {
      try {
        await processInbound(env, m.body);
        m.ack();
      } catch (err) {
        console.error("inbound process failed", err);
        m.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, InboundEmail>;
