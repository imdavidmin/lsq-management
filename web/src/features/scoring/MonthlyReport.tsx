import { useState } from "react";
import {
  Button,
  Card,
  Input,
  Text,
  Title1,
  Title2,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Query } from "../../lib/Query";
import { pct } from "../../lib/format";
import { useMonthlyReport } from "./api";

const useStyles = makeStyles({
  bar: { display: "flex", gap: tokens.spacingHorizontalM, alignItems: "end", marginBottom: tokens.spacingVerticalL },
  section: { marginBottom: tokens.spacingVerticalL },
  list: { margin: 0, paddingLeft: tokens.spacingHorizontalXL },
});

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function MonthlyReport() {
  const s = useStyles();
  const [pending, setPending] = useState(thisMonth());
  const [month, setMonth] = useState<string | null>(null);
  const q = useMonthlyReport(month ?? "", month != null);

  return (
    <div>
      <Title2>Monthly report</Title2>
      <div className={s.bar}>
        {/* Native month picker — no date-lib dependency */}
        <Input type="month" value={pending} onChange={(_, d) => setPending(d.value)} />
        <Button appearance="primary" onClick={() => setMonth(pending)}>
          Generate report
        </Button>
        {month && (
          <Button appearance="secondary" onClick={() => window.print()}>
            Download / print
          </Button>
        )}
      </div>

      {month && (
        <Query q={q}>
          {(report) => (
            <div>
              <Card style={{ padding: tokens.spacingVerticalL, marginBottom: tokens.spacingVerticalL }}>
                <Text size={200}>Projected fee — {report.month}</Text>
                <Title1 as="p">{pct(report.score?.projected_fee_ratio)}</Title1>
              </Card>

              <div className={s.section}>
                <Title3>Strong areas</Title3>
                <ul className={s.list}>
                  {report.narrative?.strong?.map((x, i) => <li key={i}><Text>{x}</Text></li>)}
                </ul>
              </div>
              <div className={s.section}>
                <Title3>Weak areas</Title3>
                <ul className={s.list}>
                  {report.narrative?.weak?.map((x, i) => <li key={i}><Text>{x}</Text></li>)}
                </ul>
              </div>
              <div className={s.section}>
                <Title3>Trend</Title3>
                <Text>{report.narrative?.trend}</Text>
              </div>
            </div>
          )}
        </Query>
      )}
    </div>
  );
}
