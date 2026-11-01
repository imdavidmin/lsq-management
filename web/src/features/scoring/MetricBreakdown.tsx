import { useState, type ReactNode } from "react";
import {
  Badge,
  Button,
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
import { ChevronDown16Regular, ChevronRight16Regular, CheckmarkCircle20Regular, Warning20Regular } from "@fluentui/react-icons";
import { Link as RouterLink } from "react-router-dom";
import type { Metric, MetricDetail } from "../../api/types";
import { usePermissions } from "../../auth/AuthProvider";
import { CollapsibleGroup, type GroupTone } from "../../components/CollapsibleGroup";
import { Query } from "../../lib/Query";
import { dateTime, pct } from "../../lib/format";
import { metricLabel } from "../../../../common/strings";
import { InfoPopover } from "./InfoPopover";
import { formatValue } from "./metricValue";
import { DOMAINS, StatCard } from "./Scorecard";
import { useMetricDetail, useMetrics } from "./api";

const useStyles = makeStyles({
  page: { display: "grid", gap: tokens.spacingVerticalL },
  title: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: tokens.spacingHorizontalL },
  toggle: { width: "40px" },
  narrow: { width: "90px" },
  nested: { paddingLeft: "40px", paddingBottom: tokens.spacingVerticalS },
});

const OUTCOME = { met: "success", breached: "danger", running: "informative" } as const;

type Ticket = NonNullable<MetricDetail["tickets"]>[number];

// The arithmetic behind one metric's result, in words.
function explain(def: Metric | undefined, m: NonNullable<MetricDetail["metric"]>, ongoing: boolean) {
  if (m.pending)
    return ongoing
      ? "No value yet, so it's assumed met (100%) while the year is in progress."
      : "No value by the end of the year, so it scores 0%.";
  if (!def) return `Scores ${pct(m.result)}.`;
  if (def.mode === "proportional")
    return `${pct(m.value)} against a target of ${pct(def.threshold)}: ${pct(m.value)} ÷ ${pct(def.threshold)}, capped at 100%, scores ${pct(m.result)}.`;
  if (def.threshold == null) return `Pass/fail: ${formatValue(def, m.value)}, so it scores ${pct(m.result)}.`;
  return `${m.value} against a pass mark of ${def.threshold}: ${m.result ? "met" : "not met"}, so it scores ${pct(m.result)}.`;
}

// How one dashboard metric's score was arrived at, with the tickets behind it.
export function MetricBreakdown({ metricKey, year }: { metricKey: string; year?: number }) {
  const s = useStyles();
  const { has } = usePermissions();
  const q = useMetricDetail(metricKey, year);
  const def = useMetrics().data?.find((m) => m.key === metricKey);

  return (
    <div className={s.page}>
      <RouterLink to="#dashboard">← Dashboard</RouterLink>
      <div className={s.title}>
        <Title2>{metricLabel(metricKey)}</Title2>
        {def && (
          <InfoPopover label={`About ${metricLabel(metricKey)}`}>
            <Text weight="semibold">{DOMAINS[def.domain!] ?? def.domain}</Text>
            {def.description && <Text>{def.description}</Text>}
          </InfoPopover>
        )}
      </div>

      <Query q={q}>
        {({ metric: m, ongoing, tickets }) => {
          const met = tickets!.filter((t) => t.passes === true);
          const breached = tickets!.filter((t) => t.passes === false);
          const pending = tickets!.filter((t) => t.passes == null);
          return (
            <>
              <div className={s.cards}>
                <StatCard
                  label="Score"
                  value={pct(m!.result)}
                  hint={
                    <>
                      <Text block>Value: {formatValue(def, m!.value)} ({m!.basis})</Text>
                      <Text block>{explain(def, m!, !!ongoing)}</Text>
                      <Text block>
                        Weighted at {pct(m!.weight)} of the fee, it contributes {pct((m!.weight ?? 0) * (m!.result ?? 0))}.
                      </Text>
                    </>
                  }
                />
                {m!.source === "auto" && (
                  <>
                    <StatCard label="Total tickets" value={tickets!.length} hint="Tickets this metric's SLAs apply to this year." />
                    <StatCard label="Met SLA" value={met.length} hint="Tickets whose SLAs all finished in time." />
                    <StatCard label="Breached SLA" value={breached.length} hint="Tickets with at least one SLA over budget." />
                  </>
                )}
              </div>
              {m!.source === "manual" && <RouterLink to="#manual">See entered values</RouterLink>}
              {m!.source === "auto" && has("sla:read") && <RouterLink to={`#slas/${metricKey}`}>See the SLAs</RouterLink>}

              {m!.source === "auto" && (
                <div>
                  <Section title="Breached" tone="danger" icon={<Warning20Regular />} tickets={breached} />
                  <Section title="Met" tone="success" icon={<CheckmarkCircle20Regular />} tickets={met} />
                  {pending.length > 0 && <Section title="Not counted yet" tickets={pending} />}
                </div>
              )}
            </>
          );
        }}
      </Query>
    </div>
  );
}

// One outcome's tickets, as a collapsible section like the dashboard's areas.
function Section({ title, tone, icon, tickets }: { title: string; tone?: GroupTone; icon?: ReactNode; tickets: Ticket[] }) {
  const s = useStyles();
  return (
    <CollapsibleGroup title={title} count={tickets.length} tone={tone} icon={icon}>
      <Table size="small">
        <TableHeader>
          <TableRow>
            <TableHeaderCell className={s.toggle} />
            <TableHeaderCell className={s.narrow}>Ticket</TableHeaderCell>
            <TableHeaderCell>Description</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tickets.map((t) => (
            <TicketRow key={t.id} t={t} />
          ))}
        </TableBody>
      </Table>
    </CollapsibleGroup>
  );
}

// A ticket row that expands to show when it was raised and its SLA instances.
function TicketRow({ t }: { t: Ticket }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const instances = t.instances!;
  return (
    <>
      <TableRow>
        <TableCell>
          <Button
            appearance="subtle"
            size="small"
            icon={open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
            aria-expanded={open}
            aria-label={`SLAs for ticket ${t.id}`}
            onClick={() => setOpen(!open)}
          />
        </TableCell>
        <TableCell>
          <RouterLink to={`/tickets/${t.id}`}>#{t.id}</RouterLink>
        </TableCell>
        <TableCell>
          <RouterLink to={`/tickets/${t.id}`}>{t.title}</RouterLink>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={3} className={s.nested}>
            <Table size="extra-small">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Event</TableHeaderCell>
                  <TableHeaderCell>Started</TableHeaderCell>
                  <TableHeaderCell>Stopped</TableHeaderCell>
                  <TableHeaderCell>Working days</TableHeaderCell>
                  <TableHeaderCell>Outcome</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>Ticket raised</TableCell>
                  <TableCell>{dateTime(t.created_at)}</TableCell>
                  <TableCell colSpan={3} />
                </TableRow>
                {instances.map((i, n) => (
                  <TableRow key={n}>
                    <TableCell>{i.name}</TableCell>
                    <TableCell>{dateTime(i.start_at)}</TableCell>
                    <TableCell>{i.stop_at ? dateTime(i.stop_at) : "Still open"}</TableCell>
                    <TableCell>{i.days} of {i.budget_days}</TableCell>
                    <TableCell>
                      <Badge size="small" appearance="tint" color={OUTCOME[i.outcome!]}>{i.outcome}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
