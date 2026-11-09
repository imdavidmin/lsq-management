import { Badge, Card, Text, makeStyles, shorthands, tokens } from "@fluentui/react-components";
import type { Event, Ticket } from "../api/types";
import { date } from "../lib/format";
import { categoryColor, humanize, lastEventLabel, slaDueColor, slaDueLabel } from "./ticketDisplay";

const useStyles = makeStyles({
  card: {
    maxWidth: "250px",
    height: "150px",
    padding: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    cursor: "pointer",
    // Cards sit on the same neutral bg as the page, so a border does the work
    // of separating them. Hover lifts the border + shadow rather than swapping
    // the whole card to a grey fill (Fluent's default filled-Card behaviour).
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border(tokens.strokeWidthThin, "solid", tokens.colorNeutralStroke2),
    boxShadow: tokens.shadow4,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1,
      ...shorthands.borderColor(tokens.colorBrandStroke1),
      boxShadow: tokens.shadow16,
    },
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
  },
  pill: {
    borderRadius: tokens.borderRadiusCircular,
    padding: `1px ${tokens.spacingHorizontalS}`,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    whiteSpace: "nowrap",
  },
  tags: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
  contractor: {
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: "0.04em",
    color: tokens.colorNeutralForeground3,
  },
  body: {
    flex: 1,
    minHeight: 0,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  title: {
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  preview: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    color: tokens.colorNeutralForeground3,
  },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
  },
});

export function TicketCard({
  ticket,
  onClick,
  onDoubleClick,
}: {
  ticket: Ticket & { events?: Event[] };
  onClick?: () => void;
  onDoubleClick?: () => void;
}) {
  const s = useStyles();
  const events = ticket.events ?? [];
  const last = events.length ? events[events.length - 1] : undefined;
  const updated = (last?.at ?? ticket.created_at) ?? undefined;
  const lastComment = [...events].reverse().find((e) => e.type === "comment")?.body;
  const color = categoryColor(ticket.category);

  return (
    <Card className={s.card} onClick={onClick} onDoubleClick={onDoubleClick}>
      <div className={s.header} style={{ backgroundColor: color.bg }}>
        <span className={s.pill} style={{ backgroundColor: color.fg, color: tokens.colorNeutralBackground1 }}>
          {ticket.category ? humanize(ticket.category) : "uncategorised"}
        </span>
        <span className={s.tags}>
          {ticket.needs_contractor && <span className={s.contractor}>CONTRACTOR</span>}
          {ticket.sla_due && (
            <Badge size="small" appearance="filled" color={slaDueColor(ticket.sla_due.remaining_days)} title={ticket.sla_due.name}>
              {slaDueLabel(ticket.sla_due.remaining_days)}
            </Badge>
          )}
        </span>
      </div>
      <div className={s.body}>
        <Text weight="semibold" size={300} className={s.title}>#{ticket.id} · {ticket.title}</Text>
        {lastComment && <Text size={200} className={s.preview}>{lastComment}</Text>}
      </div>
      <div className={s.footer}>
        <Text size={200}>{lastEventLabel(last)}</Text>
        <Text size={200}>{date(updated)}</Text>
      </div>
    </Card>
  );
}
