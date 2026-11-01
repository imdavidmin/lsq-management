// AG Grid setup shared by feature grids: register modules once, theme follows the app's light/dark mode.
import { AllCommunityModule, ModuleRegistry, colorSchemeDark, colorSchemeLight, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

export const agTheme = (dark: boolean) => (dark ? agThemeDark : agThemeLight);
const agThemeDark = themeQuartz.withPart(colorSchemeDark);
const agThemeLight = themeQuartz.withPart(colorSchemeLight);
