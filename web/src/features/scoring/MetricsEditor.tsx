import { useState } from "react";
import {
  Button,
  Dropdown,
  Input,
  Option,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title2,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Query } from "../../lib/Query";
import type { Metric, MetricMode } from "../../api/types";
import { useMetrics, usePatchMetric } from "./api";

const useStyles = makeStyles({
  note: { marginBottom: tokens.spacingVerticalM, display: "block" },
  num: { width: "90px" },
});

function MetricRow({ metric }: { metric: Metric }) {
  const s = useStyles();
  const patch = usePatchMetric();
  const [draft, setDraft] = useState<Metric>(metric);
  const dirty = JSON.stringify(draft) !== JSON.stringify(metric);

  return (
    <TableRow>
      <TableCell>{draft.key}</TableCell>
      <TableCell>{draft.domain}</TableCell>
      <TableCell>
        <Input
          className={s.num}
          type="number"
          step={0.01}
          value={String(draft.weight ?? "")}
          onChange={(_, d) => setDraft({ ...draft, weight: Number(d.value) })}
        />
      </TableCell>
      <TableCell>
        <Dropdown
          value={draft.mode}
          selectedOptions={[draft.mode!]}
          onOptionSelect={(_, d) => setDraft({ ...draft, mode: d.optionValue as MetricMode })}
        >
          <Option value="binary">binary</Option>
          <Option value="proportional">proportional</Option>
        </Dropdown>
      </TableCell>
      <TableCell>
        {/* Threshold units vary by metric (rating 4.0 / count 2.0 / ratio 0.9) */}
        <Input
          className={s.num}
          type="number"
          step={0.01}
          value={draft.threshold == null ? "" : String(draft.threshold)}
          onChange={(_, d) =>
            setDraft({ ...draft, threshold: d.value === "" ? null : Number(d.value) })
          }
        />
      </TableCell>
      <TableCell>{draft.source}</TableCell>
      <TableCell>
        <Switch
          checked={!!draft.active}
          onChange={(_, d) => setDraft({ ...draft, active: d.checked })}
        />
      </TableCell>
      <TableCell>
        <Button
          size="small"
          appearance="primary"
          disabled={!dirty || patch.isPending}
          onClick={() =>
            patch.mutate({
              key: draft.key!,
              weight: draft.weight,
              mode: draft.mode,
              threshold: draft.threshold,
              active: draft.active,
            })
          }
        >
          Save
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function MetricsEditor() {
  const s = useStyles();
  const q = useMetrics();
  return (
    <div>
      <Title2>Metric configuration</Title2>
      <Text className={s.note} size={200}>
        One effective weight per metric; all rows should sum to 1.0. Domain weight
        is derived. Threshold units depend on the metric (star rating, count, or
        ratio).
      </Text>
      <Query q={q}>
        {(metrics) => (
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Key</TableHeaderCell>
                <TableHeaderCell>Domain</TableHeaderCell>
                <TableHeaderCell>Weight</TableHeaderCell>
                <TableHeaderCell>Mode</TableHeaderCell>
                <TableHeaderCell>Threshold</TableHeaderCell>
                <TableHeaderCell>Source</TableHeaderCell>
                <TableHeaderCell>Active</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {metrics.map((m) => (
                <MetricRow key={m.key} metric={m} />
              ))}
            </TableBody>
          </Table>
        )}
      </Query>
    </div>
  );
}
