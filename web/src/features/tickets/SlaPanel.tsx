import {
  Badge,
  Card,
  MessageBar,
  MessageBarBody,
  Switch,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { dateTime } from "../../lib/format";
import type { Event } from "../../api/types";

// Provisional: SLA-clock contract is unsettled (docs/sla-tracking.md, OPEN).
const PROVISIONAL_SLA = true;

const useStyles = makeStyles({
  card: { padding: tokens.spacingVerticalL, gap: tokens.spacingVerticalM },
  clock: { display: "flex", gap: tokens.spacingHorizontalS, alignItems: "center" },
});

export function SlaPanel({ events }: { events: Event[] }) {
  const s = useStyles();
  if (!PROVISIONAL_SLA) return null;

  const clocks = events.filter((e) => e.type === "clock");

  return (
    <Card className={s.card} appearance="outline">
      <Title3>SLA (provisional)</Title3>
      <MessageBar intent="warning" layout="multiline">
        <MessageBarBody>
          Provisional — SLA clock computation and scoring exclusion are not yet
          finalised on the backend.
        </MessageBarBody>
      </MessageBar>

      {clocks.length === 0 ? (
        <Text size={200}>No clock events on this ticket yet.</Text>
      ) : (
        clocks.map((c) => (
          <div key={c.id} className={s.clock}>
            <Badge appearance="tint">{c.to_value ?? "clock"}</Badge>
            <Text size={200}>{dateTime(c.at)}</Text>
          </div>
        ))
      )}

      <Switch
        label="Exclude from scoring (extraordinary circumstance)"
        disabled
        checked={false}
      />
      <Text size={100}>Control disabled until the exclusion contract lands.</Text>
    </Card>
  );
}
