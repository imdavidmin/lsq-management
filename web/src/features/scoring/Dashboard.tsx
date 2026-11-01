import { useState } from "react";
import {
  Badge,
  Dropdown,
  Option,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title2,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { CheckmarkCircle20Regular, Info16Regular, Warning20Regular } from "@fluentui/react-icons";
import { Link as RouterLink } from "react-router-dom";
import { usePermissions } from "../../auth/AuthProvider";
import { CollapsibleGroup } from "../../components/CollapsibleGroup";
import { Query } from "../../lib/Query";
import { pct } from "../../lib/format";
import { metricLabel } from "../../../../common/strings";
import { InfoPopover } from "./InfoPopover";
import { formatValue } from "./metricValue";
import { DOMAINS, Scorecard } from "./Scorecard";
import { useMetrics, useScore } from "./api";

const useStyles = makeStyles({
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: tokens.spacingVerticalM },
  title: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
  info: { verticalAlign: "middle", color: tokens.colorNeutralForeground3 },
});

const ORDER = Object.keys(DOMAINS);
export const span = (y: number) => `${y}–${String(y + 1).slice(2)}`;

export function Dashboard() {
  const s = useStyles();
  const { has } = usePermissions();
  const [year, setYear] = useState<number>();
  const current = useScore(); // the server decides the current service year
  const q = useScore(year);
  const metrics = useMetrics();
  const byKey = new Map((metrics.data ?? []).map((m) => [m.key!, m]));
  const cur = current.data?.service_year;

  return (
    <div>
      <div className={s.header}>
        <div className={s.title}>
          <Title2>Performance fee</Title2>
          <InfoPopover label="How the performance fee works">
            <Text weight="semibold">How the performance fee works</Text>
            <Text>
              The fee is the weighted total of every metric's score, grouped into the rubric's six areas. Each
              metric scores between 0% and 100%, and its weight is its share of the fee.
            </Text>
            <Text>
              While a service year is in progress, metrics without a value yet are assumed met, so the figure
              is a projection. Once the year ends, anything still without a value scores 0.
            </Text>
            <Text>
              Ticket-based metrics are measured against their{" "}
              {has("sla:read") ? <RouterLink to="#slas">SLAs</RouterLink> : "SLAs"}; other values are entered
              on the <RouterLink to="#manual">Manual values</RouterLink> tab or come from the resident survey.
              {has("metric:manage") && (
                <>
                  {" "}Targets and weights are set on the <RouterLink to="#metrics">Metrics</RouterLink> tab.
                </>
              )}
            </Text>
            <Text>
              After the year ends, the board takes a{" "}
              <RouterLink to="#snapshots">year-end snapshot</RouterLink> that becomes the final record.
            </Text>
          </InfoPopover>
        </div>
        {cur != null && (
          <Dropdown
            value={span(year ?? cur)}
            selectedOptions={[String(year ?? cur)]}
            onOptionSelect={(_, d) => setYear(Number(d.optionValue))}
          >
            {[cur, cur - 1].map((y) => (
              <Option key={y} value={String(y)} text={span(y)}>{span(y)}</Option>
            ))}
          </Dropdown>
        )}
      </div>

      <Query q={q}>
        {(score) => (
          <>
            <Scorecard score={score} />

            {[...(score.domains ?? [])]
              .sort((a, b) => ORDER.indexOf(a.domain!) - ORDER.indexOf(b.domain!))
              .map((d) => {
                const good = (d.result ?? 0) >= 0.85;
                return (
                  <CollapsibleGroup
                    key={d.domain}
                    title={DOMAINS[d.domain!] ?? d.domain!}
                    count={d.metrics?.length ?? 0}
                    defaultOpen={false}
                    tone={good ? "success" : "warning"}
                    icon={good ? <CheckmarkCircle20Regular /> : <Warning20Regular />}
                  >
                    <Table size="small">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Metric</TableHeaderCell>
                          <TableHeaderCell>Weight</TableHeaderCell>
                          <TableHeaderCell>Value</TableHeaderCell>
                          <TableHeaderCell>Score</TableHeaderCell>
                          <TableHeaderCell>Based on</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {d.metrics?.map((m) => {
                          const def = byKey.get(m.key!);
                          return (
                            <TableRow key={m.key}>
                              <TableCell>
                                <RouterLink to={`#dashboard/${m.key}/${score.service_year}`}>{metricLabel(m.key!)}</RouterLink>{" "}
                                {def?.description && (
                                  <Tooltip content={def.description} relationship="description" withArrow>
                                    <Info16Regular className={s.info} tabIndex={0} />
                                  </Tooltip>
                                )}
                              </TableCell>
                              <TableCell>{pct(m.weight)}</TableCell>
                              <TableCell>{formatValue(def, m.value)}</TableCell>
                              <TableCell>{pct(m.result)}</TableCell>
                              <TableCell>{m.basis}</TableCell>
                              <TableCell>
                                {!m.pending ? (
                                  <Badge appearance="tint" color="success">Scored</Badge>
                                ) : score.ongoing ? (
                                  <Badge appearance="tint" color="informative">Assumed met</Badge>
                                ) : (
                                  <Badge appearance="tint" color="danger">No value</Badge>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </CollapsibleGroup>
                );
              })}
          </>
        )}
      </Query>

    </div>
  );
}
