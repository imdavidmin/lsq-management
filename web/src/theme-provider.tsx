import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { FluentProvider, teamsHighContrastTheme } from "@fluentui/react-components";
import { lsqDarkTheme, lsqTheme } from "./theme";

export type ThemeMode = "auto" | "light" | "dark" | "contrast";

const KEY = "lsq-theme";
const MODES: ThemeMode[] = ["auto", "light", "dark", "contrast"];
const THEMES = { light: lsqTheme, dark: lsqDarkTheme, contrast: teamsHighContrastTheme };

const ThemeCtx = createContext<{ mode: ThemeMode; dark: boolean; setMode: (m: ThemeMode) => void }>({
  mode: "auto",
  dark: false,
  setMode: () => {},
});

export const useThemeMode = () => useContext(ThemeCtx);

// "auto" follows the OS: contrast preference first, then light/dark.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const contrastQuery = window.matchMedia("(prefers-contrast: more)");
const systemTheme = (): keyof typeof THEMES => (contrastQuery.matches ? "contrast" : darkQuery.matches ? "dark" : "light");

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(KEY) as ThemeMode;
    return MODES.includes(saved) ? saved : "auto";
  });
  const [system, setSystem] = useState(systemTheme);

  useEffect(() => {
    const onChange = () => setSystem(systemTheme());
    darkQuery.addEventListener("change", onChange);
    contrastQuery.addEventListener("change", onChange);
    return () => {
      darkQuery.removeEventListener("change", onChange);
      contrastQuery.removeEventListener("change", onChange);
    };
  }, []);

  const setMode = (m: ThemeMode) => {
    localStorage.setItem(KEY, m);
    setModeState(m);
  };
  const resolved = mode === "auto" ? system : mode;

  return (
    // High contrast is a black-background theme, so it counts as dark for AG Grid.
    <ThemeCtx.Provider value={{ mode, dark: resolved !== "light", setMode }}>
      <FluentProvider theme={THEMES[resolved]}>{children}</FluentProvider>
    </ThemeCtx.Provider>
  );
}
