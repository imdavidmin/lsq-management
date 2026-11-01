import type { ReactNode } from "react";
import { Button, Popover, PopoverSurface, PopoverTrigger, makeStyles, tokens } from "@fluentui/react-components";
import { Info20Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  surface: { maxWidth: "440px", display: "grid", gap: tokens.spacingVerticalS },
});

// "How this works" explainer opened from an icon beside a page title.
export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  const s = useStyles();
  return (
    <Popover withArrow positioning="below-start">
      <PopoverTrigger disableButtonEnhancement>
        <Button appearance="subtle" icon={<Info20Regular />} aria-label={label} />
      </PopoverTrigger>
      <PopoverSurface className={s.surface}>{children}</PopoverSurface>
    </Popover>
  );
}
