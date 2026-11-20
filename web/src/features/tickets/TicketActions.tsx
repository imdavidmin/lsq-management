import { useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  RadioGroup,
  Radio,
  Textarea,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { EditRegular } from "@fluentui/react-icons";
import { CATEGORIES, humanize } from "../../components/ticketDisplay";
import { STATUSES } from "../../../../common/tickets";
import type { TicketDetail, TicketStatus } from "../../api/types";
import { useAddComment, useAddMarker, usePatchTicket, useSchedule, useTriage } from "./api";

const useStyles = makeStyles({
  dialogFields: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
});

// Icon-triggered dialog: pick a new status + required comment, then commit.
export function StatusDialog({ id, current }: { id: number; current: TicketStatus }) {
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

// On-site team records a contractor visit; its notes feed the attendance SLA (D21).
export function AttendedDialog({ id }: { id: number }) {
  const s = useStyles();
  const mark = useAddMarker(id);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");

  const commit = () => mark.mutate(notes, { onSuccess: () => { setOpen(false); setNotes(""); } });

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <Button appearance="secondary" onClick={() => setOpen(true)}>Contractor attended</Button>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Contractor attended</DialogTitle>
          <DialogContent className={s.dialogFields}>
            <Field label="What was done" required>
              <Textarea value={notes} onChange={(_, d) => setNotes(d.value)} rows={3} />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button appearance="primary" disabled={mark.isPending || !notes.trim()} onClick={commit}>Record</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

// First decision on a ticket: category, contractor, and the next step (D40).
export function TriageDialog({ t }: { t: TicketDetail }) {
  const s = useStyles();
  const triage = useTriage(t.id!);
  const addComment = useAddComment(t.id!);
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [contractor, setContractor] = useState(false);
  const [step, setStep] = useState<"status" | "date">("status");
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");
  const busy = triage.isPending || addComment.isPending;
  const ready = category && comment.trim() && (step === "status" ? status : date && note.trim());

  const commit = async () => {
    try {
      // Don't re-post the comment when only the triage call failed and is retried.
      if (!addComment.isSuccess) await addComment.mutateAsync(comment);
      await triage.mutateAsync({
        category,
        needs_contractor: contractor,
        ...(step === "status" ? { status } : { date, note }),
      });
      setOpen(false);
    } catch {
      // shown via triage.error / addComment.error
    }
  };

  const onOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) return;
    setCategory(t.category ?? "");
    setContractor(!!t.needs_contractor);
    triage.reset();
    addComment.reset();
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <Button appearance="primary" size="small" onClick={() => setOpen(true)}>Triage</Button>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Triage ticket</DialogTitle>
          <DialogContent className={s.dialogFields}>
            <Field label="Category" required>
              <Dropdown
                value={category ? humanize(category) : ""}
                selectedOptions={category ? [category] : []}
                onOptionSelect={(_, d) => setCategory(d.optionValue ?? "")}
              >
                {CATEGORIES.map((c) => <Option key={c} value={c}>{humanize(c)}</Option>)}
                {category && !CATEGORIES.includes(category as (typeof CATEGORIES)[number]) && (
                  <Option value={category}>{humanize(category)}</Option>
                )}
              </Dropdown>
            </Field>
            <Field label="Needs a contractor?">
              <RadioGroup layout="horizontal" value={contractor ? "yes" : "no"} onChange={(_, d) => setContractor(d.value === "yes")}>
                <Radio value="yes" label="Yes" />
                <Radio value="no" label="No" />
              </RadioGroup>
            </Field>
            <Field label="Next step">
              <RadioGroup layout="horizontal" value={step} onChange={(_, d) => setStep(d.value as "status" | "date")}>
                <Radio value="status" label="Change status" />
                <Radio value="date" label="Schedule action" />
              </RadioGroup>
            </Field>
            {step === "status" ? (
              <Field label="New status" required>
                <Dropdown
                  value={status ? humanize(status) : ""}
                  selectedOptions={status ? [status] : []}
                  onOptionSelect={(_, d) => setStatus(d.optionValue ?? "")}
                >
                  {STATUSES.filter((st) => st !== "open" && st !== t.status).map((st) => <Option key={st} value={st}>{humanize(st)}</Option>)}
                </Dropdown>
              </Field>
            ) : (
              <>
                <Field label="Date of next action" required>
                  <Input type="date" min={today()} value={date} onChange={(_, d) => setDate(d.value)} />
                </Field>
                <Field label="What will happen" required>
                  <Input value={note} onChange={(_, d) => setNote(d.value)} />
                </Field>
              </>
            )}
            <Field label="Comment" required>
              <Textarea value={comment} onChange={(_, d) => setComment(d.value)} rows={3} />
            </Field>
            {(triage.error ?? addComment.error) && (
              <MessageBar intent="error"><MessageBarBody>{(triage.error ?? addComment.error)!.message}</MessageBarBody></MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button appearance="primary" disabled={busy || !ready} onClick={commit}>Confirm</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// Record "next action on <date>" (D41).
export function ScheduleDialog({ id }: { id: number }) {
  const s = useStyles();
  const schedule = useSchedule(id);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");

  const commit = () => schedule.mutate({ date, note }, { onSuccess: () => { setOpen(false); setDate(""); setNote(""); } });

  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (d.open) schedule.reset(); }}>
      <Button appearance="secondary" onClick={() => setOpen(true)}>Schedule action</Button>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Schedule next action</DialogTitle>
          <DialogContent className={s.dialogFields}>
            <Field label="Date" required>
              <Input type="date" min={today()} value={date} onChange={(_, d) => setDate(d.value)} />
            </Field>
            <Field label="What will happen" required>
              <Input value={note} onChange={(_, d) => setNote(d.value)} />
            </Field>
            {schedule.error && <MessageBar intent="error"><MessageBarBody>{schedule.error.message}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button appearance="primary" disabled={schedule.isPending || !date || !note.trim()} onClick={commit}>Schedule</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// Close this ticket as a duplicate of an older one (D42).
export function DuplicateDialog({ id }: { id: number }) {
  const s = useStyles();
  const patch = usePatchTicket(id);
  const [open, setOpen] = useState(false);
  const [num, setNum] = useState("");

  const commit = () => patch.mutate({ duplicate_of: Number(num) }, { onSuccess: () => { setOpen(false); setNum(""); } });

  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (d.open) patch.reset(); }}>
      <Button appearance="secondary" onClick={() => setOpen(true)}>Mark duplicate</Button>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Mark as duplicate</DialogTitle>
          <DialogContent className={s.dialogFields}>
            <Field label="Duplicate of ticket number" required>
              <Input type="number" min={1} step={1} value={num} onChange={(_, d) => setNum(d.value)} />
            </Field>
            {patch.error && <MessageBar intent="error"><MessageBarBody>{patch.error.message}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button appearance="primary" disabled={patch.isPending || !Number.isInteger(Number(num)) || Number(num) < 1} onClick={commit}>Close as duplicate</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
