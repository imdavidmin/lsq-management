import { useState } from "react";
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Card,
  Dropdown,
  Option,
  Table,
  TableBody,
  TableCell,
  TableHeaderCell,
  TableRow,
  Text,
  Title1,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Query } from "../../lib/Query";
import { pct } from "../../lib/format";
import { useScore } from "./api";

const useStyles = makeStyles({
  head: { display: "flex", alignItems: "baseline", gap: tokens.spacingHorizontalL, marginBottom: tokens.spacingVerticalL },
  fee: { padding: tokens.spacingVerticalXL, marginBottom: tokens.spacingVerticalL, textAlign: "center" },
  domainHead: { display: "flex", gap: tokens.spacingHorizontalM, alignItems: "baseline" },
});

const YEARS = [2024, 2025, 2026];

export function Dashboard() {
  const s = useStyles();
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const q = useScore(year);

  return (
    <div>
      <div className={s.head}>
        <Title1>Performance fee</Title1>
        <Dropdown
          value={String(year)}
          selectedOptions={[String(year)]}
          onOptionSelect={(_, d) => setYear(Number(d.optionValue))}
        >
          {YEARS.map((y) => (
            <Option key={y} value={String(y)}>{String(y)}</Option>
          ))}
        </Dropdown>
      </div>

      <Query q={q}>
        {(score) => (
          <>
            <Card className={s.fee}>
              <Text size={100}>Projected fee (service year {score.service_year})</Text>
              <Title1 as="p" style={{ fontSize: "48px" }}>
                {pct(score.projected_fee_ratio)}
              </Title1>
              <Text size={200}>Σ (weight × result) across all metrics — computed live</Text>
            </Card>

            <Accordion multiple collapsible>
              {score.domains?.map((d) => (
                <AccordionItem key={d.domain} value={d.domain!}>
                  <AccordionHeader>
                    <div className={s.domainHead}>
                      <Title3>{d.domain}</Title3>
                      <Text>weight {pct(d.weight)}</Text>
                      <Badge appearance="tint" color={(d.result ?? 0) >= 0.85 ? "success" : "warning"}>
                        {pct(d.result)}
                      </Badge>
                    </div>
                  </AccordionHeader>
                  <AccordionPanel>
                    <Table size="small">
                      <TableBody>
                        <TableRow>
                          <TableHeaderCell>Metric</TableHeaderCell>
                          <TableHeaderCell>Weight</TableHeaderCell>
                          <TableHeaderCell>Value</TableHeaderCell>
                          <TableHeaderCell>Result</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                        </TableRow>
                        {d.metrics?.map((m) => (
                          <TableRow key={m.key}>
                            <TableCell>{m.key}</TableCell>
                            <TableCell>{pct(m.weight)}</TableCell>
                            <TableCell>{m.value ?? "—"}</TableCell>
                            <TableCell>{pct(m.result)}</TableCell>
                            <TableCell>
                              {m.pending ? (
                                <Badge appearance="tint" color="informative">
                                  not yet scoring
                                </Badge>
                              ) : (
                                <Badge appearance="tint" color="success">scored</Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </AccordionPanel>
                </AccordionItem>
              ))}
            </Accordion>
          </>
        )}
      </Query>
    </div>
  );
}
