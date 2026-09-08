import {
  Badge,
  Button,
  Divider,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  OverlayDrawer,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowExpand20Regular, Dismiss20Regular } from "@fluentui/react-icons";
import type { TicketDetail } from "../api/types";
import { humanize, lastEventLabel } from "./ticketDisplay";
import { Stamp } from "./Stamp";

const useStyles = makeStyles({
  drawer: { width: "360px" },
  fields: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    gap: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXL}`,
    marginBottom: tokens.spacingVerticalL,
  },
  label: { color: tokens.colorNeutralForeground3 },
  timeline: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalL },
  event: { display: "flex", gap: tokens.spacingHorizontalS, alignItems: "baseline", flexWrap: "wrap" },
});

export function TicketDrawer({
  ticket,
  open,
  onOpenChange,
  onExpand,
}: {
  ticket: TicketDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onExpand: () => void;
}) {
  const s = useStyles();
  const events = ticket?.events ?? [];

  return (
    <OverlayDrawer
      position="end"
      modalType="non-modal"
      open={open}
      onOpenChange={(_, d) => onOpenChange(d.open)}
      className={s.drawer}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <>
              <Button
                appearance="subtle"
                icon={<ArrowExpand20Regular />}
                aria-label="Open full details"
                onClick={onExpand}
              />
              <Button
                appearance="subtle"
                icon={<Dismiss20Regular />}
                aria-label="Close"
                onClick={() => onOpenChange(false)}
              />
            </>
          }
        >
          {ticket ? `#${ticket.id} · ${ticket.title}` : ""}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        {ticket && (
          <>
            <div className={s.fields}>
              <Text className={s.label}>Status</Text>
              <Text>{humanize(ticket.status)}</Text>
              <Text className={s.label}>Category</Text>
              <Text>{ticket.category ? humanize(ticket.category) : "—"} ({ticket.classified_by})</Text>
              <Text className={s.label}>Location</Text>
              <Text>
                {ticket.unit_id ? `Unit #${ticket.unit_id}` : "Communal"}
                {ticket.building_id ? ` · Building #${ticket.building_id}` : ""}
              </Text>
              <Text className={s.label}>Latest</Text>
              <Text>{lastEventLabel(events[events.length - 1])}</Text>
            </div>
            <Divider />
            <div className={s.timeline}>
              {[...events].reverse().map((e) => (
                <div key={e.id} className={s.event}>
                  <Badge appearance="tint" size="small">{humanize(e.type)}</Badge>
                  <Stamp at={e.at} />
                  {e.body && <Text size={200}>{e.body}</Text>}
                </div>
              ))}
            </div>
          </>
        )}
      </DrawerBody>
    </OverlayDrawer>
  );
}
