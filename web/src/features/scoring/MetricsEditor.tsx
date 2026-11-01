import { useMemo, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
  Title2,
  makeStaticStyles,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { Link } from "react-router-dom";
import { agTheme } from "../../lib/grid";
import { useThemeMode } from "../../theme-provider";
import { Query } from "../../lib/Query";
import type { Metric } from "../../api/types";
import { capitalise, metricLabel } from "../../../../common/strings";
import { useMetrics, useSaveMetrics, useSlas } from "./api";
import { InfoPopover } from "./InfoPopover";

const useStyles = makeStyles({
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: tokens.spacingVerticalM,
  },
  actions: { display: "flex", gap: tokens.spacingHorizontalS },
  title: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
});
// Let header tooltips break onto one line per value; keep long descriptions readable.
const useTooltipStyles = makeStaticStyles({ ".ag-tooltip": { whiteSpace: "pre-line", maxWidth: "400px" } });

const MODE_TIP = [
  "Binary: scores 1 if the value meets the threshold, else 0.",
  "Proportional: scores value ÷ threshold, capped at 1.",
].join("\n");
const SOURCE_TIP = [
  "Auto: computed from tickets against the metric's SLAs.",
  "Manual: entered by the agent or admin.",
  "Survey: average resident rating, scored once enough responses exist.",
].join("\n");

// Fields editable here; `active` is still accepted by the API but not shown.
type Draft = Pick<Metric, "weight" | "threshold" | "description">;
const draftOf = ({ weight, threshold, description }: Metric): Draft => ({
  weight,
  threshold,
  description: description ?? null,
});

// Ratios are stored 0..1 but shown and edited ×100 (0.03 → 3), so the editor sees the display value.
const x100 = (v: number) => +(v * 100).toFixed(2);
// Proportional thresholds are ratios; binary ones are raw units (star rating, count).
const isRatio = (m: Metric) => m.mode === "proportional";

function MetricTable({ metrics }: { metrics: Metric[] }) {
  const s = useStyles();
  useTooltipStyles();
  const { dark } = useThemeMode();
  const saveMetrics = useSaveMetrics();
  const slas = useSlas();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // Server's rejection reasons (one per line), shown in a blocking dialog.
  const [problems, setProblems] = useState<string[]>([]);

  const rows = useMemo(() => metrics.map((m) => ({ ...m, ...drafts[m.key!] })), [metrics, drafts]);
  const dirty = metrics.filter((m) => drafts[m.key!] && JSON.stringify(drafts[m.key!]) !== JSON.stringify(draftOf(m)));

  const discard = () => setDrafts({});
  const save = async () => {
    try {
      await saveMetrics.mutateAsync(dirty.map((m) => ({ key: m.key!, ...drafts[m.key!] })));
      discard();
    } catch (e) {
      setProblems((e as Error).message.split("\n"));
    }
  };

  const cols = useMemo<ColDef<Metric>[]>(
    () => [
      { headerName: "Metric", valueGetter: (p) => metricLabel(p.data!.key!), flex: 1, minWidth: 160 },
      { field: "key", hide: true },
      { field: "domain", valueFormatter: (p) => capitalise(p.value), width: 120 },
      {
        field: "weight",
        editable: true,
        width: 100,
        cellEditor: "agNumberCellEditor",
        valueGetter: (p) => x100(p.data!.weight!),
        valueSetter: (p) => {
          p.data.weight = (p.newValue ?? 0) / 100;
          return true;
        },
      },
      {
        field: "mode",
        headerName: "Mode ⓘ",
        headerTooltip: MODE_TIP,
        valueFormatter: (p) => capitalise(p.value),
        width: 140,
      },
      {
        field: "source",
        headerName: "Source ⓘ",
        headerTooltip: SOURCE_TIP,
        valueFormatter: (p) => capitalise(p.value),
        width: 120,
      },
      {
        field: "threshold",
        editable: true,
        width: 110,
        cellEditor: "agNumberCellEditor",
        valueGetter: (p) => {
          const t = p.data!.threshold;
          return t != null && isRatio(p.data!) ? x100(t) : t;
        },
        valueFormatter: (p) => (p.value == null ? "—" : isRatio(p.data!) ? `${p.value}%` : String(p.value)),
        valueSetter: (p) => {
          const n: number | null = p.newValue ?? null;
          p.data.threshold = n != null && isRatio(p.data) ? n / 100 : n;
          return true;
        },
      },
      { field: "description", editable: true, flex: 2, minWidth: 200, tooltipField: "description" },
      {
        headerName: "SLAs",
        width: 110,
        // Auto metrics link to their SLAs, opened on the SLAs tab (#slas/<key>).
        cellRenderer: (p: { data: Metric }) => {
          const n = (slas.data ?? []).filter((x) => x.metric_key === p.data.key).length;
          return n > 0 && <Link to={{ hash: `slas/${p.data.key}` }}>{n} SLA{n === 1 ? "" : "s"}</Link>;
        },
      },
    ],
    [slas.data]
  );

  return (
    <>
      <div className={s.header}>
        <div className={s.title}>
          <Title2>Metric configuration</Title2>
          <InfoPopover label="How scoring works">
            <Text weight="semibold">How scoring works</Text>
            <Text>
              Each metric scores between 0 and 1 for the service year. The performance score is the
              sum of weight × score across all metrics, so with weights summing to 100 it is a score
              out of 100 that sets the agent's performance fee.
            </Text>
            <Text>
              <b>Source</b> — where the value comes from. <i>Auto</i> metrics are computed from
              tickets: the share of tickets that met every one of the metric's{" "}
              <Link to="#slas">SLAs</Link>. <i>Manual</i> values are entered by the agent or admin.{" "}
              <i>Survey</i> values are the average resident rating, scored once enough units respond.
            </Text>
            <Text>
              <b>Threshold</b> — the target the value is measured against. For proportional metrics
              it is a percentage; for binary metrics it is in the metric's own units (star rating
              or count).
            </Text>
            <Text>
              <b>Mode</b> — how the value turns into a score. <i>Binary</i> scores 1 if the value
              meets the threshold, otherwise 0. <i>Proportional</i> scores value ÷ threshold, capped
              at 1, so partial delivery earns partial credit.
            </Text>
            <Text>The board can dispute any value, and the corrected value is used instead.</Text>
          </InfoPopover>
        </div>
        {dirty.length > 0 && (
          <div className={s.actions}>
            <Button onClick={discard}>Discard</Button>
            <Button appearance="primary" disabled={saveMetrics.isPending} onClick={save}>
              Save ({dirty.length})
            </Button>
          </div>
        )}
      </div>
      <Dialog open={problems.length > 0} onOpenChange={(_, d) => !d.open && setProblems([])}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Changes not saved</DialogTitle>
            <DialogContent>
              Your changes cannot be saved for the following reasons:
              <ul>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setProblems([])}>
                Back to editing
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <AgGridReact<Metric>
        theme={agTheme(dark)}
        rowData={rows}
        columnDefs={cols}
        getRowId={(p) => p.data.key!}
        domLayout="autoHeight"
        stopEditingWhenCellsLoseFocus
        tooltipShowDelay={300}
        onCellValueChanged={(e) => setDrafts((d) => ({ ...d, [e.data.key!]: draftOf(e.data) }))}
      />
    </>
  );
}

export function MetricsEditor() {
  const q = useMetrics();
  return <Query q={q}>{(metrics) => <MetricTable metrics={metrics} />}</Query>;
}
