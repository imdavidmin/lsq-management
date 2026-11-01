import { useState } from "react";
import {
  Badge,
  Button,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Radio,
  RadioGroup,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  Title2,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Link } from "react-router-dom";
import { usePermissions } from "../../auth/AuthProvider";
import { Query } from "../../lib/Query";
import { dateTime, pct } from "../../lib/format";
import type { MetricValue } from "../../api/types";
import { metricLabel } from "../../../../common/strings";
import { formatValue, kindOf } from "./metricValue";
import { useCreateMetricValue, useAttest, useMetricValues, useMetrics, useScore } from "./api";
import { InfoPopover } from "./InfoPopover";

const useStyles = makeStyles({
  title: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS, marginBottom: tokens.spacingVerticalM },
  form: { display: "grid", gap: tokens.spacingVerticalM, maxWidth: "480px", marginBottom: tokens.spacingVerticalXXL },
  hint: { color: tokens.colorNeutralForeground2 },
});

export function ManualEntry() {
  const score = useScore();
  // The server only accepts the current service year, which /score resolves.
  return <Query q={score}>{(s) => <ManualValues year={s.service_year!} />}</Query>;
}

function ManualValues({ year }: { year: number }) {
  const s = useStyles();
  const { has } = usePermissions();
  const canEnter = has("metric:enter");
  const canAttest = has("metric:attest");
  const canDispute = has("metric:dispute");
  const metrics = useMetrics();
  const values = useMetricValues({ year });
  const create = useCreateMetricValue();
  const attest = useAttest();

  const [metricKey, setMetricKey] = useState<string>("");
  const [value, setValue] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  // The board may also dispute computed (ticket and survey) metrics.
  const enterable = (metrics.data ?? []).filter((m) => m.active && (m.source === "manual" || canDispute));
  const byKey = new Map((metrics.data ?? []).map((m) => [m.key!, m]));
  const selected = byKey.get(metricKey);
  const kind = selected && kindOf(selected);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!metricKey || value === "") return;
    const n = kind === "percent" ? Number(value) / 100 : Number(value);
    create.mutate(
      { metric_key: metricKey, service_year: year, value: n, notes: notes || undefined },
      { onSuccess: () => { setValue(""); setNotes(""); } },
    );
  }

  // Values arrive newest first, so the first row per metric is the one that counts.
  const latestIds = (rows: MetricValue[]) => {
    const seen = new Set<string>();
    return new Set(rows.filter((v) => !seen.has(v.metric_key!) && seen.add(v.metric_key!)).map((v) => v.id));
  };

  return (
    <div>
      <div className={s.title}>
        <Title2>Manual values</Title2>
        <InfoPopover label="How manual values work">
          <Text weight="semibold">How manual values work</Text>
          <Text>
            Some metrics can't be measured from tickets, such as financial deadlines, statutory filings,
            servicing completed and project timelines. Their values are entered here for the service year
            and count toward the performance score.
          </Text>
          <Text>
            A new entry for a metric replaces the previous one for that year. Earlier entries stay listed as
            history, so nothing is ever deleted. A value counts as soon as it's entered; the board then signs
            it off or disputes it.
          </Text>
          <Text>
            Pass/fail metrics are entered as met or not met, percentages as a percentage, and counts as a
            number.
            {has("metric:manage") && (
              <>
                {" "}Each metric's target is on the <Link to="#metrics">Metrics</Link> tab.
              </>
            )}
          </Text>
          {canDispute ? (
            <Text>
              You can sign off a value, or dispute it by entering a corrected value with a note explaining
              why. Ticket-based and survey metrics can be disputed here too, and the corrected value replaces
              the computed one for the year.
            </Text>
          ) : canEnter ? (
            <Text>
              Enter a value once the work is done, for example when window cleaning is completed or HIU
              servicing figures are in. The board will sign it off or dispute it.
            </Text>
          ) : (
            <Text>Values are entered by the managing agent and admin, and signed off by the board.</Text>
          )}
        </InfoPopover>
      </div>

      {canEnter && (
        <form className={s.form} onSubmit={submit}>
          <Title3>{canDispute ? "Enter or dispute a value" : "Enter a value"}</Title3>
          <Field label="Metric" hint={selected?.description ?? undefined}>
            <Dropdown
              placeholder="Select a metric"
              selectedOptions={metricKey ? [metricKey] : []}
              value={metricKey && metricLabel(metricKey)}
              onOptionSelect={(_, d) => {
                setMetricKey(d.optionValue ?? "");
                setValue("");
              }}
            >
              {enterable.map((m) => (
                <Option key={m.key} value={m.key!}>
                  {m.source === "manual" ? metricLabel(m.key!) : `${metricLabel(m.key!)} (dispute)`}
                </Option>
              ))}
            </Dropdown>
          </Field>
          {kind === "passfail" && (
            <Field label="Result">
              <RadioGroup layout="horizontal" value={value} onChange={(_, d) => setValue(d.value)}>
                <Radio value="1" label="Met" />
                <Radio value="0" label="Not met" />
              </RadioGroup>
            </Field>
          )}
          {kind === "percent" && (
            <Field label="Percentage achieved">
              <Input type="number" min={0} max={100} step={0.1} contentAfter="%" value={value} onChange={(_, d) => setValue(d.value)} />
            </Field>
          )}
          {kind === "rating" && (
            <Field label="Average rating (1–5)">
              <Input type="number" min={1} max={5} step={0.01} value={value} onChange={(_, d) => setValue(d.value)} />
            </Field>
          )}
          {kind === "count" && (
            <Field label="Count">
              <Input type="number" min={0} step={1} value={value} onChange={(_, d) => setValue(d.value)} />
            </Field>
          )}
          <Field label="Notes" hint={canDispute ? "When disputing, explain why." : undefined}>
            <Textarea value={notes} onChange={(_, d) => setNotes(d.value)} />
          </Field>
          {create.isError && (
            <MessageBar intent="error">
              <MessageBarBody>{(create.error as Error).message}</MessageBarBody>
            </MessageBar>
          )}
          <Button appearance="primary" type="submit" disabled={create.isPending || !metricKey || value === ""}>
            Save value
          </Button>
        </form>
      )}

      <Title3>Values for {year}</Title3>
      <Query q={values}>
        {(rows) => {
          if (rows.length === 0)
            return (
              <MessageBar intent="info">
                <MessageBarBody>No values have been entered for {year} yet.</MessageBarBody>
              </MessageBar>
            );
          const latest = latestIds(rows);
          return (
            <Table size="small">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Metric</TableHeaderCell>
                  <TableHeaderCell>Value</TableHeaderCell>
                  <TableHeaderCell>Score</TableHeaderCell>
                  <TableHeaderCell>Entered</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Notes</TableHeaderCell>
                  <TableHeaderCell />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((v) => {
                  const current = latest.has(v.id);
                  return (
                    <TableRow key={v.id}>
                      <TableCell>{metricLabel(v.metric_key!)}</TableCell>
                      <TableCell>{formatValue(byKey.get(v.metric_key!), v.value!)}</TableCell>
                      <TableCell>{pct(v.result)}</TableCell>
                      <TableCell>{dateTime(v.computed_at)}</TableCell>
                      <TableCell>
                        {!current ? (
                          <Badge appearance="tint" color="informative">Replaced</Badge>
                        ) : v.attested_by ? (
                          <Badge appearance="tint" color="success">Signed off</Badge>
                        ) : (
                          <Badge appearance="tint" color="warning">Awaiting sign-off</Badge>
                        )}
                      </TableCell>
                      <TableCell>{v.notes ?? "—"}</TableCell>
                      <TableCell>
                        {current && !v.attested_by && canAttest && (
                          <Button size="small" disabled={attest.isPending} onClick={() => attest.mutate(v.id!)}>
                            Sign off
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          );
        }}
      </Query>
    </div>
  );
}
