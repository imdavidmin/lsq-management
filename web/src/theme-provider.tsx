import { createContext, useContext, useState, type ReactNode } from "react";
import { FluentProvider } from "@fluentui/react-components";
import { lsqDarkTheme, lsqTheme } from "./theme";

const KEY = "lsq-theme";
const ThemeCtx = createContext<{ dark: boolean; toggle: () => void }>({
  dark: false,
  toggle: () => {},
});

export const useThemeMode = () => useContext(ThemeCtx);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(() => localStorage.getItem(KEY) === "dark");
  const toggle = () =>
    setDark((d) => {
      localStorage.setItem(KEY, d ? "light" : "dark");
      return !d;
    });

  return (
    <ThemeCtx.Provider value={{ dark, toggle }}>
      <FluentProvider theme={dark ? lsqDarkTheme : lsqTheme}>{children}</FluentProvider>
    </ThemeCtx.Provider>
  );
}
