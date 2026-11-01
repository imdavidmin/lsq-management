import { useState, type ReactElement, type ReactNode } from "react";
import { Card, Text, Title1, Tooltip, makeStyles, tokens } from "@fluentui/react-components";
import { Info16Regular } from "@fluentui/react-icons";
import type { Score } from "../../api/types";
import { pct } from "../../lib/format";
import { useThemeMode } from "../../theme-provider";

// Rubric section names, in rubric order (docs/requirements.md).
export const DOMAINS: Record<string, string> = {
  financial: "Financial Management",
  governance: "Governance & Administration",
  site: "Site Management",
  contractor: "Contractor Management",
  resident: "Resident & Board Service",
  projects: "Projects Execution",
};
const ORDER = Object.keys(DOMAINS);

// Categorical slots 1–6, validated for colour-blind separation in both modes (dataviz palette).
const LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
const DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"];

const useStyles = makeStyles({
  cards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(300px, 360px))",
    gap: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalXL,
  },
  card: {
    padding: tokens.spacingVerticalL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow8,
    gap: tokens.spacingVerticalS,
  },
  hint: { color: tokens.colorNeutralForeground2 },
  // Centre the headline figure in the space left under the label.
  fee: { fontSize: "48px", lineHeight: "56px", margin: 0, flexGrow: 1, display: "flex", alignItems: "center", justifyContent: "center" },
  label: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
  info: { color: tokens.colorNeutralForeground3 },
  // Same gap as between cells, so the two blocks read as one.
  waffle: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "2px" },
  group: { display: "grid", gridTemplateColumns: "repeat(10, 12px)", gap: "2px" },
  cell: { width: "12px", height: "12px", borderRadius: "2px" },
  // Fixed height so hovering doesn't resize the card.
  detail: { display: "flex", alignItems: "center", justifyContent: "center", gap: tokens.spacingHorizontalS, minHeight: "24px" },
  swatch: { width: "12px", height: "12px", borderRadius: "3px", flexShrink: 0 },
});

// Faded version of a series colour for unfilled squares and meter tracks.
const tint = (c: string) => `color-mix(in srgb, ${c} 22%, transparent)`;

// Integer counts per item that always sum to the rounded total, so the squares match the headline %.
const cumulativeRound = (xs: number[]) => {
  let sum = 0;
  return xs.map((x) => {
    const before = Math.round(sum);
    sum += x;
    return Math.round(sum) - before;
  });
};

export function Scorecard({ score }: { score: Score }) {
  const s = useStyles();
  const { dark } = useThemeMode();
  const palette = dark ? DARK : LIGHT;
  const domains = [...(score.domains ?? [])].sort((a, b) => ORDER.indexOf(a.domain!) - ORDER.indexOf(b.domain!));
  const [hovered, setHovered] = useState<string | null>(null);
  const active = domains.find((d) => d.domain === hovered);
  const colour = (domain: string) => palette[ORDER.indexOf(domain)] ?? tokens.colorNeutralForeground3;

  // 100 squares: each area owns its weight's worth, filled in proportion to its score.
  const owned = cumulativeRound(domains.map((d) => (d.weight ?? 0) * 100));
  const filled = cumulativeRound(domains.map((d) => (d.weight ?? 0) * (d.result ?? 0) * 100));
  const squares = domains.flatMap((d, i) =>
    Array.from({ length: owned[i] }, (_, j) => ({ domain: d.domain!, on: j < filled[i], result: d.result }))
  );

  return (
    <div className={s.cards}>
      <StatCard
        label={`${score.ongoing ? "Projected" : "Final"} fee`}
        hint={
          score.ongoing
            ? "Year in progress: metrics without a value yet are assumed met."
            : "Year ended: metrics without a value score 0."
        }
        value={pct(score.projected_fee_ratio)}
      />

      <Card className={s.card}>
        <div className={s.label}>
          <Text size={300} weight="semibold">Breakdown</Text>
          <Hint text="Each square is one point of the fee, coloured by area. Filled squares are points achieved." />
        </div>
        <div
          className={s.waffle}
          role="img"
          aria-label={`${pct(score.projected_fee_ratio)} of 100 points achieved`}
          onMouseLeave={() => setHovered(null)}
        >
          {/* Two blocks of 5 rows × 10, laid side by side. */}
          {[squares.slice(0, 50), squares.slice(50)].map((group, g) => (
            <div key={g} className={s.group}>
              {group.map((q, i) => (
                <div
                  key={i}
                  className={s.cell}
                  onMouseEnter={() => setHovered(q.domain)}
                  style={{
                    backgroundColor: q.on ? colour(q.domain) : tint(colour(q.domain)),
                    opacity: hovered && hovered !== q.domain ? 0.3 : 1,
                  }}
                />
              ))}
            </div>
          ))}
        </div>
        <div className={s.detail}>
          {active ? (
            <>
              <span className={s.swatch} style={{ backgroundColor: colour(active.domain!) }} />
              <Text weight="semibold">{DOMAINS[active.domain!] ?? active.domain}</Text>
              <Text>
                <Text weight="semibold">{pct(active.result)}</Text>
                <span className={s.hint}> | {pct(active.weight)} of fee</span>
              </Text>
            </>
          ) : (
            <Text size={200} className={s.hint}>Hover a square to see its area.</Text>
          )}
        </div>
      </Card>
    </div>
  );
}

// A labelled headline figure, with its explanation in an info tooltip.
export function StatCard({ label, hint, value }: { label: string; hint: string | ReactElement; value: ReactNode }) {
  const s = useStyles();
  return (
    <Card className={s.card}>
      <div className={s.label}>
        <Text size={300} weight="semibold">{label}</Text>
        <Hint text={hint} />
      </div>
      <Title1 as="p" className={s.fee}>{value}</Title1>
    </Card>
  );
}

function Hint({ text }: { text: string | ReactElement }) {
  const s = useStyles();
  return (
    <Tooltip content={text} relationship="description" withArrow>
      <Info16Regular className={s.info} tabIndex={0} />
    </Tooltip>
  );
}
