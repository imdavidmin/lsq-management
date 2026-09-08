import { useState } from "react";
import {
  Badge,
  Button,
  Dropdown,
  Field,
  Input,
  Option,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Textarea,
  Title2,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Can } from "../../auth/Can";
import { Query } from "../../lib/Query";
import { dateTime } from "../../lib/format";
import { useCreateMetricValue, useAttest, useMetricValues, useMetrics } from "./api";

const useStyles = makeStyles({
  form: { display: "grid", gap: tokens.spacingVerticalM, maxWidth: "480px", marginBottom: tokens.spacingVerticalXXL },
});

export function ManualEntry() {
  const s = useStyles();
  const year = new Date().getFullYear();
  const metrics = useMetrics();
  const values = useMetricValues({ year });
  const create = useCreateMetricValue();
  const attest = useAttest();

  const [metricKey, setMetricKey] = useState<string>("");
  const [value, setValue] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const manualMetrics = (metrics.data ?? []).filter((m) => m.source === "manual");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!metricKey || value === "") return;
    create.mutate(
      { metric_key: metricKey, service_year: year, value: Number(value), notes: notes || undefined },
      { onSuccess: () => { setValue(""); setNotes(""); } },
    );
  }

  return (
    <div>
      <Title2>Manual metric values</Title2>

      <Can perm="metric:enter">
        <form className={s.form} onSubmit={submit}>
          <Title3>Enter / dispute a value</Title3>
          <Field label="Metric">
            <Dropdown
              placeholder="Select a manual metric"
              selectedOptions={metricKey ? [metricKey] : []}
              value={metricKey}
              onOptionSelect={(_, d) => setMetricKey(d.optionValue ?? "")}
            >
              {manualMetrics.map((m) => (
                <Option key={m.key} value={m.key!} text={m.key ?? ""}>{m.key}</Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="Value (units per the metric)">
            <Input type="number" step={0.01} value={value} onChange={(_, d) => setValue(d.value)} />
          </Field>
          <Field label="Notes (optional)">
            <Textarea value={notes} onChange={(_, d) => setNotes(d.value)} />
          </Field>
          <Button appearance="primary" type="submit" disabled={create.isPending || !metricKey || value === ""}>
            Save value
          </Button>
        </form>
      </Can>

      <Title3>Values for {year}</Title3>
      <Query q={values}>
        {(rows) => (
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Metric</TableHeaderCell>
                <TableHeaderCell>Value</TableHeaderCell>
                <TableHeaderCell>Result</TableHeaderCell>
                <TableHeaderCell>Entered</TableHeaderCell>
                <TableHeaderCell>Attested</TableHeaderCell>
                <TableHeaderCell>Notes</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>{v.metric_key}</TableCell>
                  <TableCell>{v.value}</TableCell>
                  <TableCell>{v.result}</TableCell>
                  <TableCell>{dateTime(v.computed_at)}</TableCell>
                  <TableCell>
                    {v.attested_by ? (
                      <Badge appearance="tint" color="success">attested</Badge>
                    ) : (
                      <Badge appearance="tint" color="warning">pending</Badge>
                    )}
                  </TableCell>
                  <TableCell>{v.notes ?? "—"}</TableCell>
                  <TableCell>
                    {!v.attested_by && (
                      <Can perm="metric:attest">
                        <Button
                          size="small"
                          disabled={attest.isPending}
                          onClick={() => attest.mutate(v.id!)}
                        >
                          Attest
                        </Button>
                      </Can>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Query>
    </div>
  );
}
