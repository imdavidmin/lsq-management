import { Tab, TabList, makeStyles, tokens } from "@fluentui/react-components";
import { useLocation, useNavigate } from "react-router-dom";
import { AlphaOverlay } from "../../components/AlphaOverlay";
import { usePermissions } from "../../auth/AuthProvider";
import { Dashboard } from "./Dashboard";
import { MetricsEditor } from "./MetricsEditor";
import { ManualEntry } from "./ManualEntry";
import { MetricBreakdown } from "./MetricBreakdown";
import { MonthlyReport } from "./MonthlyReport";
import { SlasEditor } from "./SlasEditor";
import { Snapshots } from "./Snapshots";

const useStyles = makeStyles({
  tabs: { marginBottom: tokens.spacingVerticalL },
});

export function PerformancePage() {
  const s = useStyles();
  const { has } = usePermissions();
  const navigate = useNavigate();
  // The hash picks the tab, optionally followed by a metric (and year): #slas/res.ticket_acknowledgement.
  const [hashTab, metric, year] = useLocation().hash.slice(1).split("/");
  const tab = hashTab || "dashboard";

  return (
    <div>
      <TabList
        className={s.tabs}
        selectedValue={tab}
        onTabSelect={(_, d) => navigate({ hash: d.value as string })}
      >
        <Tab value="dashboard">Dashboard</Tab>
        {has("score:read") && <Tab value="snapshots">Year-end snapshots</Tab>}
        {has("report:read") && <Tab value="report">Monthly report</Tab>}
        {has("metric:read") && <Tab value="manual">Manual values</Tab>}
        {has("metric:manage") && <Tab value="metrics">Metrics</Tab>}
        {has("sla:read") && <Tab value="slas">SLAs</Tab>}
      </TabList>

      {tab === "dashboard" && (metric ? <MetricBreakdown metricKey={metric} year={year ? Number(year) : undefined} /> : <Dashboard />)}
      {tab === "snapshots" && <AlphaOverlay view="snapshots"><Snapshots /></AlphaOverlay>}
      {tab === "report" && <AlphaOverlay view="report"><MonthlyReport /></AlphaOverlay>}
      {tab === "manual" && <AlphaOverlay view="manual"><ManualEntry /></AlphaOverlay>}
      {tab === "metrics" && <MetricsEditor />}
      {tab === "slas" && <SlasEditor focus={metric} />}
    </div>
  );
}
