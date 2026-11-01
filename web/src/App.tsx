import { Navigate, Route, Routes } from "react-router-dom";
import { Spinner } from "@fluentui/react-components";
import { useAuth } from "./auth/AuthProvider";
import { LoginPage } from "./auth/LoginPage";
import { AppShell } from "./shell/AppShell";
import { TicketsPage } from "./features/tickets/TicketsPage";
import { TicketDetailPage } from "./features/tickets/TicketDetailPage";
import { PerformancePage } from "./features/scoring/PerformancePage";
import { DirectoryPage } from "./features/directory/DirectoryPage";
import { SurveysPage } from "./features/engagement/SurveysPage";
import { SiteInfoPage } from "./features/engagement/SiteInfoPage";
import { AlphaOverlay } from "./components/AlphaOverlay";
import { MyAccountPage } from "./features/account/MyAccountPage";

export function App() {
  const { identity, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <Spinner label="Loading…" />
      </div>
    );
  }

  if (!identity) return <LoginPage />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/tickets" replace />} />
        <Route path="tickets" element={<TicketsPage />} />
        <Route path="tickets/:id" element={<AlphaOverlay view="ticket-detail"><TicketDetailPage /></AlphaOverlay>} />
        <Route path="performance/*" element={<PerformancePage />} />
        <Route path="directory/*" element={<DirectoryPage />} />
        <Route path="surveys" element={<SurveysPage />} />
        <Route path="surveys/:id" element={<SurveysPage />} />
        <Route path="site-info" element={<AlphaOverlay view="site-info"><SiteInfoPage /></AlphaOverlay>} />
        <Route path="my-account" element={<MyAccountPage />} />
        <Route path="*" element={<Navigate to="/tickets" replace />} />
      </Route>
    </Routes>
  );
}
