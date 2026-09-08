import { useState, type ReactNode } from "react";
import { Badge, Text, makeStyles, tokens } from "@fluentui/react-components";
import { ChevronDown20Regular, ChevronRight20Regular } from "@fluentui/react-icons";

export type GroupTone = "neutral" | "success" | "warning" | "danger";

const useStyles = makeStyles({
  root: { marginBottom: tokens.spacingVerticalXL },
  header: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    width: "100%",
    border: "none",
    backgroundColor: "transparent",
    // Native <button> otherwise pins text/chevron to the UA color, which
    // ignores the theme. Anchor to a neutral token so it follows light/dark.
    color: tokens.colorNeutralForeground1,
    cursor: "pointer",
    padding: `${tokens.spacingVerticalS} 0`,
    textAlign: "left",
  },
  body: { display: "grid", gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM },
  empty: { color: tokens.colorNeutralForeground3, fontStyle: "italic" },
  neutral: { color: tokens.colorNeutralForeground2, display: "inline-flex" },
  success: { color: tokens.colorStatusSuccessForeground1, display: "inline-flex" },
  warning: { color: tokens.colorStatusWarningForeground1, display: "inline-flex" },
  danger: { color: tokens.colorStatusDangerForeground1, display: "inline-flex" },
});

// Titled, toned, collapsible section (chevron header + count badge).
export function CollapsibleGroup({
  title,
  count,
  tone = "neutral",
  icon,
  defaultOpen = true,
  children,
}: {
  title: string;
  count: number;
  tone?: GroupTone;
  icon?: ReactNode;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const s = useStyles();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={s.root}>
      <button className={s.header} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown20Regular /> : <ChevronRight20Regular />}
        {icon && <span className={s[tone]}>{icon}</span>}
        <Text weight="semibold" size={400}>{title}</Text>
        <Badge appearance="tint">{count}</Badge>
      </button>
      {open && (
        <div className={s.body}>
          {count === 0 ? <Text className={s.empty} size={200}>Nothing here.</Text> : children}
        </div>
      )}
    </section>
  );
}
