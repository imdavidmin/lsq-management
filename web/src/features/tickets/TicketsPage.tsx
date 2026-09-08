import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  Combobox,
  Dropdown,
  Option,
  SearchBox,
  Tab,
  TabList,
  Text,
  Title1,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AllCommunityModule, ModuleRegistry, type ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";

ModuleRegistry.registerModules([AllCommunityModule]);
import {
  CheckmarkCircle20Filled,
  Circle20Regular,
  Clock20Regular,
  Warning20Filled,
} from "@fluentui/react-icons";
import { Can } from "../../auth/Can";
import { Query } from "../../lib/Query";
import type { Account, TicketDetail } from "../../api/types";
import { CollapsibleGroup, type GroupTone } from "../../components/CollapsibleGroup";
import { CATEGORIES, humanize, isTerminal } from "../../components/ticketDisplay";
import { TicketCard } from "../../components/TicketCard";
import { TicketDrawer } from "../../components/TicketDrawer";
import { useAccounts, useBuildings } from "../directory/api";
import { NewTicketDialog } from "./NewTicketPage";
import { useTickets } from "./api";

const INACTIVE_DAYS = 14;
type Bucket = "inactive" | "open" | "pending" | "completed";

// case- and accent-insensitive; "José" matches "jose".
const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

// events are ordered oldest→newest, so the last one is the latest activity.
function lastActivityMs(t: TicketDetail): number {
  const evs = t.events ?? [];
  return new Date((evs.length ? evs[evs.length - 1].at : t.created_at) ?? "").getTime();
}

// resolved/closed → completed; else 14+ days idle → inactive; else by status.
function bucketOf(t: TicketDetail): Bucket {
  if (isTerminal(t.status)) return "completed";
  if (Date.now() - lastActivityMs(t) > INACTIVE_DAYS * 86_400_000) return "inactive";
  return t.status === "pending_3rd_party" ? "pending" : "open";
}

const GROUPS: { key: Bucket; title: string; tone: GroupTone; icon: ReactNode; defaultOpen: boolean }[] = [
  { key: "inactive", title: "Inactive — no activity in 14+ days", tone: "danger", icon: <Warning20Filled />, defaultOpen: true },
  { key: "open", title: "Open — requires response", tone: "neutral", icon: <Circle20Regular />, defaultOpen: true },
  { key: "pending", title: "Pending — awaiting resident / contractor", tone: "warning", icon: <Clock20Regular />, defaultOpen: true },
  { key: "completed", title: "Completed", tone: "success", icon: <CheckmarkCircle20Filled />, defaultOpen: false },
];

const useStyles = makeStyles({
  head: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: tokens.spacingVerticalL },
  stats: { display: "flex", gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL, flexWrap: "wrap" },
  stat: { flex: "1 1 200px", padding: tokens.spacingVerticalL, gap: tokens.spacingVerticalXS },
  attention: { backgroundColor: tokens.colorPaletteMarigoldBackground2 },
  sla: { backgroundColor: tokens.colorPaletteRedBackground2 },
  statNum: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightBold, lineHeight: "1" },
  filters: { display: "flex", gap: tokens.spacingHorizontalM, alignItems: "center", marginBottom: tokens.spacingVerticalL, flexWrap: "wrap" },
  cards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 250px))",
    gap: tokens.spacingHorizontalM,
    alignItems: "start",
  },
  viewToggle: { marginLeft: "auto" },
  grid: { width: "100%", height: "70vh" },
});

export function TicketsPage() {
  const s = useStyles();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [search, setSearch] = useState("");
  const [authorId, setAuthorId] = useState<number | undefined>();
  const [authorText, setAuthorText] = useState("");
  const [buildingId, setBuildingId] = useState<number | undefined>();
  const [category, setCategory] = useState<string>("");
  const [view, setView] = useState<"cards" | "grid">("cards");

  const q = useTickets({ page: 1, per_page: 100 });
  const accounts = useAccounts();
  const buildings = useBuildings();

  const authorName = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of accounts.data ?? []) if (a.id != null) m.set(a.id, a.name ?? "");
    return (id?: number | null) => (id != null ? m.get(id) ?? "" : "");
  }, [accounts.data]);

  const buildingName = useMemo(() => {
    const m = new Map<number, string>();
    for (const b of buildings.data ?? []) if (b.id != null) m.set(b.id, b.name ?? "");
    return (id?: number | null) => (id != null ? m.get(id) ?? "" : "");
  }, [buildings.data]);

  const authorOptions = useMemo(() => {
    const n = norm(authorText);
    return (accounts.data ?? []).filter((a) => !n || norm(a.name ?? "").includes(n));
  }, [accounts.data, authorText]);

  return (
    <div>
      <div className={s.head}>
        <Title1>Tickets</Title1>
        <Can perm="ticket:create">
          <NewTicketDialog />
        </Can>
      </div>

      <Query q={q}>
        {(res) => {
          const nq = norm(search);
          const shown = res.data.filter((t) => {
            if (authorId != null && t.created_by !== authorId) return false;
            if (buildingId != null && t.building_id !== buildingId) return false;
            if (category && t.category !== category) return false;
            if (nq) {
              const hay = norm(`${t.title ?? ""} ${authorName(t.created_by)}`);
              if (!hay.includes(nq)) return false;
            }
            return true;
          });

          // ponytail: SLA is provisional (SlaPanel), so inactivity is the proxy
          // for "at risk" until the real SLA clock lands.
          const attention = res.data.filter((t) => {
            const b = bucketOf(t);
            return b === "open" || b === "inactive";
          }).length;
          const atRisk = res.data.filter((t) => bucketOf(t) === "inactive").length;

          return (
            <>
              <div className={s.stats}>
                <Card className={`${s.stat} ${s.attention}`}>
                  <Text className={s.statNum}>{attention}</Text>
                  <Text weight="semibold">Need your attention</Text>
                  <Text size={200}>Open or stalled tickets awaiting a response.</Text>
                </Card>
                <Card className={`${s.stat} ${s.sla}`}>
                  <Text className={s.statNum}>{atRisk}</Text>
                  <Text weight="semibold">Immediate follow-up</Text>
                  <Text size={200}>No activity in {INACTIVE_DAYS}+ days — SLA at risk.</Text>
                </Card>
              </div>

              <div className={s.filters}>
                <SearchBox
                  placeholder="Search title or author"
                  value={search}
                  onChange={(_, d) => setSearch(d.value)}
                  style={{ minWidth: "240px" }}
                />
                <Combobox
                  placeholder="Any author"
                  value={authorText}
                  selectedOptions={authorId != null ? [String(authorId)] : []}
                  onChange={(e) => { setAuthorText(e.target.value); if (!e.target.value) setAuthorId(undefined); }}
                  onOptionSelect={(_, d) => {
                    const id = d.optionValue ? Number(d.optionValue) : undefined;
                    setAuthorId(id);
                    setAuthorText(id != null ? authorName(id) : "");
                  }}
                  clearable
                >
                  {authorOptions.map((a: Account) => (
                    <Option key={a.id} value={String(a.id)} text={a.name ?? ""}>{a.name}</Option>
                  ))}
                </Combobox>
                <Dropdown
                  placeholder="Any building"
                  value={buildingId != null ? buildings.data?.find((b) => b.id === buildingId)?.name ?? "" : ""}
                  selectedOptions={buildingId != null ? [String(buildingId)] : []}
                  onOptionSelect={(_, d) => setBuildingId(d.optionValue ? Number(d.optionValue) : undefined)}
                  clearable
                >
                  {(buildings.data ?? []).map((b) => (
                    <Option key={b.id} value={String(b.id)} text={b.name ?? ""}>{b.name}</Option>
                  ))}
                </Dropdown>
                <Dropdown
                  placeholder="Any category"
                  value={category ? humanize(category) : ""}
                  selectedOptions={category ? [category] : []}
                  onOptionSelect={(_, d) => setCategory(d.optionValue ?? "")}
                  clearable
                >
                  {CATEGORIES.map((c) => <Option key={c} value={c}>{humanize(c)}</Option>)}
                </Dropdown>
                <TabList
                  className={s.viewToggle}
                  selectedValue={view}
                  onTabSelect={(_, d) => setView(d.value as "cards" | "grid")}
                >
                  <Tab value="cards">Cards</Tab>
                  <Tab value="grid">Grid</Tab>
                </TabList>
              </div>

              {view === "cards" ? (
                <Buckets tickets={shown} onOpen={setSelected} onExpand={(t) => navigate(`/tickets/${t.id}`)} />
              ) : (
                <Grid
                  tickets={shown}
                  authorName={authorName}
                  buildingName={buildingName}
                  onOpen={setSelected}
                  onExpand={(t) => navigate(`/tickets/${t.id}`)}
                />
              )}
            </>
          );
        }}
      </Query>

      <TicketDrawer
        ticket={selected}
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
        onExpand={() => selected && navigate(`/tickets/${selected.id}`)}
      />
    </div>
  );
}

function Buckets({ tickets, onOpen, onExpand }: { tickets: TicketDetail[]; onOpen: (t: TicketDetail) => void; onExpand: (t: TicketDetail) => void }) {
  const s = useStyles();
  const byBucket = useMemo(() => {
    const m: Record<Bucket, TicketDetail[]> = { inactive: [], open: [], pending: [], completed: [] };
    for (const t of tickets) m[bucketOf(t)].push(t);
    return m;
  }, [tickets]);

  return (
    <>
      {GROUPS.map((g) => (
        <CollapsibleGroup
          key={g.key}
          title={g.title}
          count={byBucket[g.key].length}
          tone={g.tone}
          icon={g.icon}
          defaultOpen={g.defaultOpen}
        >
          <div className={s.cards}>
            {byBucket[g.key].map((t) => (
              <TicketCard key={t.id} ticket={t} onClick={() => onOpen(t)} onDoubleClick={() => onExpand(t)} />
            ))}
          </div>
        </CollapsibleGroup>
      ))}
    </>
  );
}

function Grid({
  tickets,
  authorName,
  buildingName,
  onOpen,
  onExpand,
}: {
  tickets: TicketDetail[];
  authorName: (id?: number | null) => string;
  buildingName: (id?: number | null) => string;
  onOpen: (t: TicketDetail) => void;
  onExpand: (t: TicketDetail) => void;
}) {
  const s = useStyles();
  const cols = useMemo<ColDef<TicketDetail>[]>(
    () => [
      { field: "id", headerName: "#", maxWidth: 90 },
      { field: "title", flex: 2, minWidth: 200 },
      { headerName: "Author", flex: 1, valueGetter: (p) => authorName(p.data?.created_by) },
      { headerName: "Building", flex: 1, valueGetter: (p) => buildingName(p.data?.building_id) },
      { headerName: "Category", flex: 1, valueGetter: (p) => humanize(p.data?.category) },
      { headerName: "Status", flex: 1, valueGetter: (p) => humanize(p.data?.status) },
      {
        headerName: "Last activity",
        flex: 1,
        valueGetter: (p) => (p.data ? lastActivityMs(p.data) : 0),
        valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleDateString() : ""),
      },
    ],
    [authorName, buildingName],
  );

  return (
    <div className={s.grid}>
      <AgGridReact<TicketDetail>
        rowData={tickets}
        columnDefs={cols}
        defaultColDef={{ sortable: true, filter: true, resizable: true }}
        onRowClicked={(e) => e.data && onOpen(e.data)}
        onRowDoubleClicked={(e) => e.data && onExpand(e.data)}
      />
    </div>
  );
}
