import type { Preview } from "@storybook/react";
import { FluentProvider } from "@fluentui/react-components";
import { lsqTheme } from "../src/theme";

// Wrap every story in the app's Fluent theme so components render as they do live.
const preview: Preview = {
  decorators: [
    (Story) => (
      <FluentProvider theme={lsqTheme}>
        <Story />
      </FluentProvider>
    ),
  ],
};
export default preview;
