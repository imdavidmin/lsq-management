import { useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Avatar,
  Button,
  Menu,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  Accessibility24Regular,
  ClipboardTaskListLtr24Regular,
  DarkTheme24Regular,
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
import { useThemeMode, type ThemeMode } from "../theme-provider";
import "@fontsource/fraunces/600.css";
import "@fontsource/instrument-sans/500.css";

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

const THEMES: Record<ThemeMode, { label: string; icon: JSX.Element }> = {
  auto: { label: "Automatic", icon: <DarkTheme24Regular /> },
  light: { label: "Light", icon: <WeatherSunny24Regular /> },
  dark: { label: "Dark", icon: <WeatherMoon24Regular /> },
  contrast: { label: "High contrast", icon: <Accessibility24Regular /> },
};

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
  headerCollapsed: { flexDirection: "column" },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    ":hover > span:first-child": { filter: "saturate(1.4) brightness(1.1)" },
  },
  // The logo file is only the shape (mask); the colour is a live CSS conic-gradient so it can animate.
  mark: {
    width: "32px",
    height: "32px",
    flexShrink: 0,
    backgroundImage: "conic-gradient(from 135deg, #642d09, #f3b896)",
    maskImage: "url(/logo.svg)",
    WebkitMaskImage: "url(/logo.svg)",
    maskSize: "contain",
    WebkitMaskSize: "contain",
    transition: "filter 200ms ease",
    // Remounted on collapse/expand (keyed), so this plays on every toggle.
    animationName: {
      "50%": { filter: "saturate(1.5) brightness(1.12)" },
    },
    animationDuration: "400ms",
    animationTimingFunction: "ease-out",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none", transition: "none" },
  },
  wordmark: { display: "flex", flexDirection: "column", lineHeight: 1.1, whiteSpace: "nowrap" },
  wordmarkName: {
    fontFamily: "Fraunces, Georgia, serif",
    fontWeight: 600,
    fontSize: "20px",
    color: tokens.colorNeutralForeground1,
  },
  wordmarkSub: {
    fontFamily: '"Instrument Sans", system-ui, sans-serif',
    fontWeight: 500,
    fontSize: "10px",
    letterSpacing: "0.35em",
    color: tokens.colorNeutralForeground3,
  },
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
  // Resets <button> so the theme trigger matches the nav links.
  linkButton: {
    border: "none",
    background: "none",
    font: "inherit",
    cursor: "pointer",
    textAlign: "left",
    ":hover": { backgroundColor: tokens.colorSubtleBackgroundHover },
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
  userButton: { flex: 1, justifyContent: "flex-start", minWidth: 0 },
  main: { padding: tokens.spacingVerticalXXL, overflow: "auto" },
});

export function AppShell() {
  const s = useStyles();
  const { identity, logout } = useAuth();
  const { hasAny } = usePermissions();
  const { mode, setMode } = useThemeMode();
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
        <div className={mergeClasses(s.header, collapsed && s.headerCollapsed)}>
          <div className={s.brand} role="img" aria-label="Lansbury Square">
            <span key={String(collapsed)} className={s.mark} />
            {!collapsed && (
              <span className={s.wordmark}>
                <span className={s.wordmarkName}>Lansbury</span>
                <span className={s.wordmarkSub}>SQUARE</span>
              </span>
            )}
          </div>
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
        <Menu
          checkedValues={{ theme: [mode] }}
          onCheckedValueChange={(_, d) => setMode(d.checkedItems[0] as ThemeMode)}
        >
          <MenuTrigger disableButtonEnhancement>
            <button
              type="button"
              title={collapsed ? `Theme: ${THEMES[mode].label}` : undefined}
              className={mergeClasses(s.link, s.linkButton, collapsed && s.linkCollapsed)}
            >
              <span className={s.icon}>{THEMES[mode].icon}</span>
              <span className={labelCls}>Theme: {THEMES[mode].label}</span>
            </button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {(Object.keys(THEMES) as ThemeMode[]).map((m) => (
                <MenuItemRadio key={m} name="theme" value={m} icon={THEMES[m].icon}>
                  {THEMES[m].label}
                </MenuItemRadio>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
        <div className={s.user}>
          <Button
            appearance="subtle"
            className={s.userButton}
            icon={<Avatar name={identity?.account?.name} size={28} />}
            aria-label={`My account: ${identity?.account?.name ?? ""}`}
            title="My account"
            onClick={() => navigate("/my-account")}
          >
            {!collapsed && <Text size={200}>{identity?.account?.name}</Text>}
          </Button>
          {!collapsed && (
            <>
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
