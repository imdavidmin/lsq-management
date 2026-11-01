import { useState } from "react";
import {
  Button,
  Checkbox,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  OverlayDrawer,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  Tooltip,
  Title2,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Add20Regular, ArrowRepeatAll16Regular, Dismiss20Regular, Info16Regular } from "@fluentui/react-icons";
import { Link as RouterLink } from "react-router-dom";
import { usePermissions } from "../../auth/AuthProvider";
import { Query } from "../../lib/Query";
import { CollapsibleGroup } from "../../components/CollapsibleGroup";
import { CATEGORIES } from "../../components/ticketDisplay";
import { capitalise, metricLabel } from "../../../../common/strings";
import { KIND_VALUES, START_KINDS, STOP_KINDS, type SlaKind } from "../../../../common/sla";
import { useMetrics, useSaveSla, useScore, useSlas, useSnapshots, type SlaDraft } from "./api";
import { InfoPopover } from "./InfoPopover";

const useStyles = makeStyles({
  header: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  title: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
  note: { marginBottom: tokens.spacingVerticalM, display: "block" },
  row: { cursor: "pointer" },
  inactive: { color: tokens.colorNeutralForeground4 },
  info: { verticalAlign: "middle", color: tokens.colorNeutralForeground3 },
  drawer: { width: "480px" },
  form: { display: "grid", gap: tokens.spacingVerticalM },
  // Fluent's Dropdown defaults to a 250px min-width, which overflows the drawer when paired.
  dropdown: { minWidth: 0 },
  pair: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: tokens.spacingHorizontalS },
  preview: { fontStyle: "italic", color: tokens.colorNeutralForeground2 },
});

const KIND_LABEL: Record<SlaKind, string> = {
  ticket_created: "ticket created",
  status: "status becomes",
  event_by: "an event by",
  marker: "marker",
};

const words = (v: string) => v.replace(/_/g, " ");
const workingDays = (n: number) => `${n} working day${n === 1 ? "" : "s"}`;
const point = (kind: SlaKind, value: string | null) =>
  kind === "ticket_created" ? "created" : words(value ?? "?");

const appliesTo = (s: SlaDraft) =>
  [
    s.category ? `${words(s.category)} tickets` : "all tickets",
    s.needs_contractor === true && "needing a contractor",
    s.needs_contractor === false && "not needing a contractor",
  ]
    .filter(Boolean)
    .join(" ");

const EMPTY: SlaDraft = {
  name: "",
  metric_key: "",
  category: null,
  needs_contractor: null,
  start_on: "ticket_created",
  start_value: null,
  stop_on: "event_by",
  stop_value: "staff",
  budget_days: 2,
  repeats: false,
  active: true,
  description: null,
};

function SlaDrawer({ draft, onClose, canEdit }: { draft: SlaDraft | null; onClose: () => void; canEdit: boolean }) {
  const s = useStyles();
  const save = useSaveSla();
  // Metric picker only for editors; agents lack metric:read.
  const metrics = useMetrics();
  const [form, setForm] = useState<SlaDraft>(draft ?? EMPTY);
  const set = (patch: Partial<SlaDraft>) => setForm((f) => ({ ...f, ...patch }));
  // Switching kind resets the value to the kind's first option (or NULL).
  const kindPatch = (side: "start" | "stop", kind: SlaKind) => ({
    [`${side}_on`]: kind,
    [`${side}_value`]: KIND_VALUES[kind][0] ?? null,
  });
  const autoMetrics = (canEdit ? metrics.data ?? [] : []).filter((m) => m.source === "auto");
  const valid = form.name.trim() !== "" && form.metric_key !== "" && form.budget_days > 0;

  const kindPicker = (side: "start" | "stop", kinds: SlaKind[]) => {
    const kind = form[`${side}_on`];
    const value = form[`${side}_value`];
    const values = KIND_VALUES[kind] as readonly string[];
    return (
      <div className={s.pair}>
        <Dropdown
          className={s.dropdown}
          disabled={!canEdit}
          value={KIND_LABEL[kind]}
          selectedOptions={[kind]}
          onOptionSelect={(_, d) => set(kindPatch(side, d.optionValue as SlaKind))}
        >
          {kinds.map((k) => (
            <Option key={k} value={k}>{KIND_LABEL[k]}</Option>
          ))}
        </Dropdown>
        {values.length > 0 && (
          <Dropdown
            className={s.dropdown}
            disabled={!canEdit}
            value={words(value ?? "")}
            selectedOptions={value ? [value] : []}
            onOptionSelect={(_, d) => set({ [`${side}_value`]: d.optionValue ?? null })}
          >
            {values.map((v) => (
              <Option key={v} value={v}>{words(v)}</Option>
            ))}
          </Dropdown>
        )}
      </div>
    );
  };

  const contractorLabel = { any: "any", yes: "needing a contractor", no: "not needing a contractor" };
  const contractorKey = form.needs_contractor == null ? "any" : form.needs_contractor ? "yes" : "no";

  return (
    <OverlayDrawer position="end" open onOpenChange={(_, d) => !d.open && onClose()} className={s.drawer}>
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close" onClick={onClose} />}
        >
          {draft?.id == null ? "New SLA" : canEdit ? "Edit SLA" : "SLA"}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={s.form}>
          <Field label="Name" required>
            <Input disabled={!canEdit} value={form.name} onChange={(_, d) => set({ name: d.value })} />
          </Field>
          <Field label="Description">
            <Textarea
              disabled={!canEdit}
              value={form.description ?? ""}
              onChange={(_, d) => set({ description: d.value || null })}
            />
          </Field>
          <Field label="Counts toward" required>
            <Dropdown
              className={s.dropdown}
              disabled={!canEdit}
              value={form.metric_key && metricLabel(form.metric_key)}
              selectedOptions={form.metric_key ? [form.metric_key] : []}
              onOptionSelect={(_, d) => set({ metric_key: d.optionValue ?? "" })}
            >
              {autoMetrics.map((m) => (
                <Option key={m.key} value={m.key!} text={metricLabel(m.key!)}>{`${metricLabel(m.key!)} · ${capitalise(m.domain!)}`}</Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="For tickets">
            <div className={s.pair}>
              <Dropdown
                className={s.dropdown}
                disabled={!canEdit}
                value={form.category ? words(form.category) : "any category"}
                selectedOptions={[form.category ?? ""]}
                onOptionSelect={(_, d) => set({ category: d.optionValue || null })}
              >
                <Option value="">any category</Option>
                {CATEGORIES.map((c) => (
                  <Option key={c} value={c}>{words(c)}</Option>
                ))}
              </Dropdown>
              <Dropdown
                className={s.dropdown}
                disabled={!canEdit}
                value={contractorLabel[contractorKey]}
                selectedOptions={[contractorKey]}
                onOptionSelect={(_, d) =>
                  set({ needs_contractor: d.optionValue === "any" ? null : d.optionValue === "yes" })
                }
              >
                {Object.entries(contractorLabel).map(([k, label]) => (
                  <Option key={k} value={k}>{label}</Option>
                ))}
              </Dropdown>
            </div>
          </Field>
          <Field label="Clock starts on">{kindPicker("start", START_KINDS)}</Field>
          <Field label="Clock stops on">{kindPicker("stop", STOP_KINDS)}</Field>
          <Field label="Within (working days)" required>
            <Input
              disabled={!canEdit}
              type="number"
              min={1}
              value={String(form.budget_days)}
              onChange={(_, d) => set({ budget_days: Number(d.value) })}
            />
          </Field>
          <Checkbox
            disabled={!canEdit}
            label="Repeat each time the start happens"
            checked={form.repeats}
            onChange={(_, d) => set({ repeats: !!d.checked })}
          />
          <Text className={s.preview}>
            For {appliesTo(form)}, {form.repeats ? "every" : "the first"}{" "}
            {form.start_on === "ticket_created" ? "ticket creation" : point(form.start_on, form.start_value)} must be
            followed by {point(form.stop_on, form.stop_value)} within {workingDays(form.budget_days)}.
          </Text>
          <Switch
            disabled={!canEdit}
            label="Active"
            checked={form.active}
            onChange={(_, d) => set({ active: d.checked })}
          />
          {save.isError && (
            <MessageBar intent="error">
              <MessageBarBody>{(save.error as Error).message}</MessageBarBody>
            </MessageBar>
          )}
        </div>
      </DrawerBody>
      {canEdit && (
        <DrawerFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            appearance="primary"
            disabled={!valid || save.isPending}
            onClick={() => save.mutate(form, { onSuccess: onClose })}
          >
            Save
          </Button>
        </DrawerFooter>
      )}
    </OverlayDrawer>
  );
}

// Edits re-score the just-ended year too, until its snapshot freezes the figures (D21).
function UnsnapshottedBanner() {
  const current = useScore().data?.service_year;
  const snaps = useSnapshots().data;
  if (current == null || !snaps || snaps.some((x) => x.service_year === current - 1)) return null;
  return (
    <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
      <MessageBarBody>
        Service year {current - 1} has no snapshot yet — editing SLAs re-scores it. Take the
        year-end snapshot on the Dashboard first.
      </MessageBarBody>
    </MessageBar>
  );
}

// `focus` (from the URL hash) opens that metric's group and collapses the rest.
export function SlasEditor({ focus }: { focus?: string }) {
  const s = useStyles();
  const { has } = usePermissions();
  const canEdit = has("sla:manage");
  const slasQ = useSlas();
  // null = closed; EMPTY = new; a row = edit/view.
  const [open, setOpen] = useState<SlaDraft | null>(null);

  return (
    <div>
      <div className={s.header}>
        <div className={s.title}>
          <Title2>SLAs</Title2>
          <InfoPopover label="How SLAs work">
            <Text weight="semibold">How SLAs work</Text>
            <Text>
              An SLA is a deadline on a ticket: from a <b>start</b> event (e.g. ticket created) to a{" "}
              <b>stop</b> event (e.g. a staff reply), within a <b>budget</b> of working days. It can
              apply to all tickets or only some (e.g. cleaning), and a repeating SLA restarts every time
              its start event happens again.
            </Text>
            <Text>
              Each time an SLA applies it is <i>met</i> if the stop event happens within budget,
              or <i>breached</i> if it happens late or hasn't happened once the budget runs out. Anything still
              within its budget doesn't count until it finishes.
            </Text>
            <Text>
              Every SLA feeds one ticket-based metric. That metric's value is the share of the
              year's tickets that met all of its SLAs, which is then scored on the{" "}
              <RouterLink to="#metrics">Metrics</RouterLink> tab.
            </Text>
          </InfoPopover>
        </div>
        {canEdit && (
          <Button icon={<Add20Regular />} appearance="primary" disabled onClick={() => setOpen(EMPTY)}>
            New SLA
          </Button>
        )}
      </div>
      <Text className={s.note} size={200}>
        Editing an SLA re-scores the current service year. Deactivate rather than delete.
        Where a metric has several SLAs, a ticket passes only if all are met.
      </Text>
      <UnsnapshottedBanner />

      <Query q={slasQ}>
        {(slas) => {
          const metrics = [...new Set(slas.map((x) => x.metric_key))];
          return metrics.map((metric) => {
            const rows = slas.filter((x) => x.metric_key === metric);
            return (
            <CollapsibleGroup
              key={`${metric}:${focus}`}
              title={metricLabel(metric)}
              count={rows.length}
              defaultOpen={!focus || focus === metric}
            >
              <Table size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Applies to</TableHeaderCell>
                    <TableHeaderCell>Clock</TableHeaderCell>
                    <TableHeaderCell>Budget</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((x) => (
                    <TableRow
                      key={x.id}
                      className={x.active ? s.row : `${s.row} ${s.inactive}`}
                      onClick={() => setOpen(x)}
                    >
                      <TableCell>
                        {x.name}{" "}
                        {x.description && (
                          <Tooltip content={x.description} relationship="description" withArrow>
                            <Info16Regular className={s.info} tabIndex={0} />
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell>{appliesTo(x)}</TableCell>
                      <TableCell>
                        {x.repeats && <ArrowRepeatAll16Regular aria-label="repeats" />}{" "}
                        {point(x.start_on, x.start_value)} → {point(x.stop_on, x.stop_value)}
                      </TableCell>
                      <TableCell>{workingDays(x.budget_days)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CollapsibleGroup>
            );
          });
        }}
      </Query>

      {/* Remount per open so the form state starts from the clicked row. */}
      {open && <SlaDrawer key={open.id ?? "new"} draft={open} canEdit={canEdit} onClose={() => setOpen(null)} />}
    </div>
  );
}
