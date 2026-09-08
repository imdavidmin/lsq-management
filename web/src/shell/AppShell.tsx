import { useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Avatar,
  Button,
  Text,
  Title3,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ClipboardTaskListLtr24Regular,
  DataTrending24Regular,
  Info24Regular,
  PanelLeftContract24Regular,
  PanelLeftExpand24Regular,
  People24Regular,
  SignOut24Regular,
  TicketDiagonal24Regular,
  WeatherMoon24Regular,
  WeatherSunny24Regular,
} from "@fluentui/react-icons";
import { useAuth, usePermissions } from "../auth/AuthProvider";
import { useThemeMode } from "../theme-provider";

// Nav is a static list; each entry is shown only if the caller holds one of its
// permissions. Server still enforces every route (D18).
const NAV: { label: string; to: string; icon: ReactNode; anyOf: string[] }[] = [
  { label: "Tickets", to: "/tickets", icon: <TicketDiagonal24Regular />, anyOf: ["ticket:read"] },
  { label: "Performance", to: "/performance", icon: <DataTrending24Regular />, anyOf: ["score:read"] },
  {
    label: "Directory",
    to: "/directory",
    icon: <People24Regular />,
    anyOf: ["account:read", "dir:read", "org:read", "sender:read", "grant:read", "role:read"],
  },
  { label: "Surveys", to: "/surveys", icon: <ClipboardTaskListLtr24Regular />, anyOf: ["survey:read", "survey:respond"] },
  { label: "Site info", to: "/site-info", icon: <Info24Regular />, anyOf: ["config:read"] },
];

const useStyles = makeStyles({
  root: {
    display: "grid",
    gridTemplateColumns: "240px 1fr",
    height: "100vh",
    overflow: "hidden",
    transition: "grid-template-columns 200ms ease",
  },
  rootCollapsed: { gridTemplateColumns: "64px 1fr" },
  side: {
    backgroundColor: tokens.colorNeutralBackground2,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: tokens.spacingVerticalL,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    overflow: "hidden",
  },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: tokens.spacingHorizontalS },
  nav: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, flex: 1 },
  link: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    textDecoration: "none",
    color: tokens.colorNeutralForeground1,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    whiteSpace: "nowrap",
  },
  linkCollapsed: { justifyContent: "center", gap: 0, padding: tokens.spacingVerticalS },
  linkActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    fontWeight: tokens.fontWeightSemibold,
  },
  icon: { display: "flex", flexShrink: 0, fontSize: "24px" },
  // Label collapses to zero width and fades; the icon stays put.
  label: {
    overflow: "hidden",
    opacity: 1,
    maxWidth: "160px",
    transition: "opacity 150ms ease, max-width 200ms ease",
  },
  labelHidden: { opacity: 0, maxWidth: 0 },
  user: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, minHeight: "32px" },
  main: { padding: tokens.spacingVerticalXXL, overflow: "auto" },
});

export function AppShell() {
  const s = useStyles();
  const { identity, logout } = useAuth();
  const { hasAny } = usePermissions();
  const { dark, toggle } = useThemeMode();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);

  const items = NAV.filter((n) => hasAny(...n.anyOf));
  const labelCls = mergeClasses(s.label, collapsed && s.labelHidden);

  async function onLogout() {
    await logout();
    navigate("/");
  }

  return (
    <div className={mergeClasses(s.root, collapsed && s.rootCollapsed)}>
      <aside className={s.side}>
        <div className={s.header}>
          {!collapsed && <Title3>Lansbury Square</Title3>}
          <Button
            appearance="subtle"
            icon={collapsed ? <PanelLeftExpand24Regular /> : <PanelLeftContract24Regular />}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          />
        </div>
        <nav className={s.nav}>
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              title={collapsed ? n.label : undefined}
              className={({ isActive }) =>
                mergeClasses(s.link, collapsed && s.linkCollapsed, isActive && s.linkActive)
              }
            >
              <span className={s.icon}>{n.icon}</span>
              <span className={labelCls}>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <Button
          appearance="subtle"
          icon={dark ? <WeatherSunny24Regular /> : <WeatherMoon24Regular />}
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          onClick={toggle}
        />
        <div className={s.user}>
          <Avatar name={identity?.account?.name} size={28} />
          {!collapsed && (
            <>
              <Text size={200}>{identity?.account?.name}</Text>
              <Button
                appearance="subtle"
                icon={<SignOut24Regular />}
                aria-label="Sign out"
                onClick={onLogout}
              />
            </>
          )}
        </div>
      </aside>
      <main className={s.main}>
        <Outlet />
      </main>
    </div>
  );
}
