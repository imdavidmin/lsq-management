import { Badge, Card, Switch, Text, Title3, makeStyles, tokens } from "@fluentui/react-components";
import { Query } from "../../lib/Query";
import { date } from "../../lib/format";
import { useTicketSlas } from "./api";

const useStyles = makeStyles({
  card: { padding: tokens.spacingVerticalL, gap: tokens.spacingVerticalM },
  row: { display: "flex", gap: tokens.spacingHorizontalS, alignItems: "baseline", justifyContent: "space-between" },
  muted: { color: tokens.colorNeutralForeground3 },
});

const COLOR = { met: "success", breached: "danger", running: "informative" } as const;

// The ticket's SLA instances, evaluated live by the server (D21).
export function SlaPanel({ id }: { id: number }) {
  const s = useStyles();
  const q = useTicketSlas(id);

  return (
    <Card className={s.card} appearance="outline">
      <Title3>SLAs</Title3>
      <Query q={q}>
        {(rows) =>
          rows.length === 0 ? (
            <Text size={200}>No SLA applies to this ticket.</Text>
          ) : (
            <>
              {rows.map((r, i) => (
                <div key={i}>
                  <div className={s.row}>
                    <Text>{r.name}</Text>
                    <Badge appearance="tint" color={COLOR[r.outcome!]}>{r.outcome}</Badge>
                  </div>
                  <Text size={200} className={s.muted}>
                    {r.days} of {r.budget_days} working days · from {date(r.start_at)}
                    {r.stop_at ? ` to ${date(r.stop_at)}` : ", still open"}
                  </Text>
                </div>
              ))}
            </>
          )
        }
      </Query>

      <Switch label="Exclude from scoring (extraordinary circumstance)" disabled checked={false} />
      <Text size={100}>Control disabled until the exclusion contract lands.</Text>
    </Card>
  );
}
