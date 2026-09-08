import { useState } from "react";
import { Tab, TabList, makeStyles, tokens } from "@fluentui/react-components";
import { usePermissions } from "../../auth/AuthProvider";
import { Dashboard } from "./Dashboard";
import { MetricsEditor } from "./MetricsEditor";
import { ManualEntry } from "./ManualEntry";
import { MonthlyReport } from "./MonthlyReport";

const useStyles = makeStyles({
  tabs: { marginBottom: tokens.spacingVerticalL },
});

export function PerformancePage() {
  const s = useStyles();
  const { has } = usePermissions();
  const [tab, setTab] = useState("dashboard");

  return (
    <div>
      <TabList
        className={s.tabs}
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as string)}
      >
        <Tab value="dashboard">Dashboard</Tab>
        {has("report:read") && <Tab value="report">Monthly report</Tab>}
        {has("metric:read") && <Tab value="manual">Manual values</Tab>}
        {has("metric:manage") && <Tab value="metrics">Configuration</Tab>}
      </TabList>

      {tab === "dashboard" && <Dashboard />}
      {tab === "report" && <MonthlyReport />}
      {tab === "manual" && <ManualEntry />}
      {tab === "metrics" && <MetricsEditor />}
    </div>
  );
}
