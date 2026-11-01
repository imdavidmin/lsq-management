import { useState, type ReactNode } from "react";
import { Button, Card, Text, makeStyles, tokens } from "@fluentui/react-components";
import { WrenchRegular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  wrap: { position: "relative", minHeight: "240px" },
  veil: {
    position: "absolute",
    inset: 0,
    zIndex: 1,
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: tokens.spacingVerticalXXXL,
    backdropFilter: "blur(3px)",
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 50%, transparent)`,
  },
  card: { maxWidth: "420px", gap: tokens.spacingVerticalM },
  icon: { fontSize: "28px", color: tokens.colorPaletteMarigoldForeground1 },
});

// Private browsing / blocked storage throws; fall back to showing the overlay each visit.
function stored(key: string) {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

// Covers an unfinished view with an alpha-release warning; dismissal sticks per `view` via localStorage.
export function AlphaOverlay({ view, children }: { view: string; children: ReactNode }) {
  const s = useStyles();
  const key = `alpha-overlay-dismissed:${view}`;
  const [dismissed, setDismissed] = useState(() => stored(key));
  const dismiss = () => {
    try { localStorage.setItem(key, "1"); } catch { /* still dismiss for this visit */ }
    setDismissed(true);
  };
  if (dismissed) return <>{children}</>;
  return (
    <div className={s.wrap}>
      {children}
      <div className={s.veil}>
        <Card className={s.card} role="alertdialog" aria-labelledby="alpha-overlay-title">
          <WrenchRegular className={s.icon} />
          <Text id="alpha-overlay-title" weight="semibold" size={400}>This view is still in progress</Text>
          <Text>
            It's part of the alpha release and isn't finished yet. Things may look rough, be missing,
            or not work as expected.
          </Text>
          <Button appearance="primary" onClick={dismiss}>Continue anyway</Button>
        </Card>
      </div>
    </div>
  );
}
