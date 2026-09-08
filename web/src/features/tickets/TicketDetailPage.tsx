import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Option,
  Text,
  Textarea,
  Title1,
  Title3,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowSyncRegular, CopyRegular, EditRegular } from "@fluentui/react-icons";
import { Can } from "../../auth/Can";
import { Query } from "../../lib/Query";
import { Stamp } from "../../components/Stamp";
import { CATEGORIES, humanize, isTerminal, roleColor } from "../../components/ticketDisplay";
import { STATUSES } from "../../../../common/tickets";
import { useAccounts, useBuildings, useUnits } from "../directory/api";
import type { Event, TicketDetail, TicketStatus } from "../../api/types";
import { useAddComment, usePatchTicket, useTicket } from "./api";
import { SlaPanel } from "./SlaPanel";

const useStyles = makeStyles({
  grid: { display: "grid", gridTemplateColumns: "1fr 320px", gap: tokens.spacingHorizontalXXL, alignItems: "start" },
  timeline: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  side: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  field: { marginBottom: tokens.spacingVerticalM },
  fieldRow: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  subtitle: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXS },
  label: { display: "block", color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalXS },
  // A comment: header row shaded by actor role, body below.
  comment: { overflow: "hidden" },
  head: { display: "flex", gap: tokens.spacingHorizontalS, alignItems: "center", flexWrap: "wrap", padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}` },
  body: { padding: tokens.spacingVerticalM },
  author: { fontWeight: tokens.fontWeightSemibold },
  muted: { color: tokens.colorNeutralForeground3 },
  time: { marginLeft: "auto" },
  // A non-comment event: a single inline line, no card.
  eventLine: { display: "flex", gap: tokens.spacingHorizontalS, alignItems: "center", padding: `0 ${tokens.spacingHorizontalM}`, color: tokens.colorNeutralForeground2 },
  composer: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, alignItems: "flex-start" },
  dialogFields: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
});


function CommentCard({ e, name }: { e: Event; name: string }) {
  const s = useStyles();
  const c = roleColor(e.actor_role);
  return (
    <Card className={s.comment} appearance="outline">
      <div className={s.head} style={{ backgroundColor: c.bg, color: c.fg }}>
        <Text className={s.author}>{name}</Text>
        {e.actor_role && <Badge appearance="tint" size="small">{e.actor_role}</Badge>}
        <span className={s.time}><Stamp at={e.at} /></span>
      </div>
      <div className={s.body}>
        <Text>{e.body}</Text>
        {e.ai_summary && <Text italic size={200} className={s.muted} block>AI: {e.ai_summary}</Text>}
      </div>
    </Card>
  );
}

function EventLine({ e, name }: { e: Event; name: string }) {
  const s = useStyles();
  const detail =
    e.type === "status"
      ? `changed status ${e.from_value ? `from ${humanize(e.from_value)} ` : ""}to ${humanize(e.to_value ?? "")}`
      : `${e.type}${e.from_value || e.to_value ? `: ${e.from_value ?? ""} → ${e.to_value ?? ""}` : ""}`;
  return (
    <div className={s.eventLine}>
      <ArrowSyncRegular />
      <Text size={200}><b>{name}</b> {detail}</Text>
      <Stamp at={e.at} />
    </div>
  );
}

function OpenedBy({ t, who }: { t: TicketDetail; who: string }) {
  const s = useStyles();
  const buildings = useBuildings();
  const units = useUnits(t.building_id);

  // Opener's role is carried on any event they authored (no extra fetch).
  const role = t.events?.find((e) => e.actor_id === t.created_by)?.actor_role;
  const building = buildings.data?.find((b) => b.id === t.building_id)?.name;
  const unit = units.data?.find((u) => u.id === t.unit_id)?.label;

  return (
    <>
      <div className={s.field}>
        <Text size={200} className={s.label}>Opened by</Text>
        <div className={s.fieldRow}>
          <Text>{who}</Text>
          {role && <Badge appearance="tint" size="small">{role}</Badge>}
          <span className={s.muted}><Stamp at={t.created_at} /></span>
        </div>
      </div>
      {building && (
        <div className={s.field}>
          <Text size={200} className={s.label}>Location</Text>
          <Text>{building}{unit ? ` · Unit ${unit}` : ""}</Text>
        </div>
      )}
    </>
  );
}

// Icon-triggered dialog: pick a new status + required comment, then commit.
function StatusDialog({ id, current }: { id: number; current: TicketStatus }) {
  const s = useStyles();
  const patch = usePatchTicket(id);
  const addComment = useAddComment(id);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<TicketStatus>(current);
  const [comment, setComment] = useState("");
  const busy = patch.isPending || addComment.isPending;

  const commit = async () => {
    await addComment.mutateAsync(comment);
    if (status !== current) await patch.mutateAsync({ status });
    setOpen(false);
    setComment("");
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (d.open) setStatus(current); }}>
      <Tooltip content="Change status" relationship="label">
        <Button appearance="subtle" size="small" icon={<EditRegular />} onClick={() => setOpen(true)} />
      </Tooltip>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Change status</DialogTitle>
          <DialogContent className={s.dialogFields}>
            <Field label="New status">
              <Dropdown
                value={humanize(status)}
                selectedOptions={[status]}
                onOptionSelect={(_, d) => setStatus(d.optionValue as TicketStatus)}
              >
                {STATUSES.map((st) => <Option key={st} value={st}>{humanize(st)}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Comment" required>
              <Textarea value={comment} onChange={(_, d) => setComment(d.value)} rows={3} />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button appearance="primary" disabled={busy || !comment} onClick={commit}>Confirm</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function TicketDetailPage() {
  const s = useStyles();
  const navigate = useNavigate();
  const id = Number(useParams().id);
  const q = useTicket(id);
  const patch = usePatchTicket(id);
  const addComment = useAddComment(id);
  const accounts = useAccounts();
  const [comment, setComment] = useState("");

  const email = `${id}@lansburysquare.co.uk`;
  // Events carry actor_id (actor_email is always null server-side); resolve to a
  // real name, falling back to role, then "system" for unattributed events.
  const nameOf = (id: number | null | undefined, role?: string | null): string =>
    accounts.data?.find((a) => a.id === id)?.name ?? role ?? "system";

  return (
    <div>
      <Button appearance="subtle" onClick={() => navigate("/tickets")}>← Tickets</Button>
      <Query q={q}>
        {(t) => (
          <>
            <Title1 block>#{t.id} · {t.title}</Title1>
            <div className={s.subtitle}>
              <Text size={200}>Reply by email: {email}</Text>
              <Tooltip content="Copy email address" relationship="label">
                <Button appearance="transparent" size="small" icon={<CopyRegular />}
                  onClick={() => void navigator.clipboard.writeText(email)} />
              </Tooltip>
            </div>

            <div className={s.grid} style={{ marginTop: tokens.spacingVerticalL }}>
              <div className={s.timeline}>
                <Title3>Timeline</Title3>
                {t.events?.map((e) =>
                  e.type === "comment"
                    ? <CommentCard key={e.id} e={e} name={nameOf(e.actor_id, e.actor_role)} />
                    : <EventLine key={e.id} e={e} name={nameOf(e.actor_id, e.actor_role)} />,
                )}

                <Can perm="ticket:comment">
                  <div className={s.composer}>
                    <Field label="Add a comment" style={{ alignSelf: "stretch" }}>
                      <Textarea value={comment} onChange={(_, d) => setComment(d.value)} rows={3} />
                    </Field>
                    <Button
                      appearance="primary"
                      disabled={addComment.isPending || !comment}
                      onClick={() => addComment.mutate(comment, { onSuccess: () => setComment("") })}
                    >
                      Comment
                    </Button>
                  </div>
                </Can>
              </div>

              <div className={s.side}>
                <Card appearance="outline" style={{ padding: tokens.spacingVerticalL }}>
                  <Title3>Details</Title3>
                  <div className={s.field}>
                    <Text size={200} className={s.label}>Status</Text>
                    <div className={s.fieldRow}>
                      <Badge appearance="filled" color={isTerminal(t.status) ? "success" : "brand"}>
                        {humanize(t.status!)}
                      </Badge>
                      <Can perm="ticket:update"><StatusDialog id={id} current={t.status!} /></Can>
                    </div>
                  </div>
                  <div className={s.field}>
                    <Text size={200} className={s.label}>Category ({t.classified_by})</Text>
                    <Can perm="ticket:update" fallback={<Text>{t.category ? humanize(t.category) : "—"}</Text>}>
                      <Dropdown
                        value={t.category ? humanize(t.category) : ""}
                        selectedOptions={t.category ? [t.category] : []}
                        placeholder="Select a category"
                        onOptionSelect={(_, d) =>
                          d.optionValue && d.optionValue !== t.category &&
                          patch.mutate({ category: d.optionValue })
                        }
                      >
                        {CATEGORIES.map((c) => <Option key={c} value={c}>{humanize(c)}</Option>)}
                        {/* Preserve a stored value that predates the fixed list. */}
                        {t.category && !CATEGORIES.includes(t.category as (typeof CATEGORIES)[number]) && (
                          <Option value={t.category}>{humanize(t.category)}</Option>
                        )}
                      </Dropdown>
                    </Can>
                  </div>
                  <OpenedBy t={t} who={accounts.data?.find((a) => a.id === t.created_by)?.name ?? (t.created_by ? `#${t.created_by}` : "unknown")} />
                </Card>

                <SlaPanel events={t.events ?? []} />
              </div>
            </div>
          </>
        )}
      </Query>
    </div>
  );
}
