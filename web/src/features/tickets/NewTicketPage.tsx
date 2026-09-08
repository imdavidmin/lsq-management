import { useState } from "react";
import { useNavigate } from "react-router-dom";
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
  Option,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Add24Regular } from "@fluentui/react-icons";
import { CATEGORIES, humanize } from "../../components/ticketDisplay";
import { useCreateTicket } from "./api";

const useStyles = makeStyles({
  form: { display: "grid", gap: tokens.spacingVerticalM },
});

// Trigger button + create dialog; category is optional — blank leaves the
// ticket for an agent to categorise.
export function NewTicketDialog() {
  const s = useStyles();
  const navigate = useNavigate();
  const create = useCreateTicket();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    create.mutate(
      { title, description, category: category || undefined },
      { onSuccess: (t) => navigate(`/tickets/${t.id}`) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <Button appearance="primary" icon={<Add24Regular />} onClick={() => setOpen(true)}>
        New ticket
      </Button>
      <DialogSurface>
        <form onSubmit={submit}>
          <DialogBody>
            <DialogTitle>New ticket</DialogTitle>
            <DialogContent className={s.form}>
              <Field label="Title" required>
                <Input value={title} onChange={(_, d) => setTitle(d.value)} autoFocus />
              </Field>
              <Field label="Description" required hint="Becomes the first event on the ticket.">
                <Textarea value={description} onChange={(_, d) => setDescription(d.value)} rows={6} />
              </Field>
              <Field label="Category" hint="Optional — leave blank for an agent to categorise.">
                <Dropdown
                  value={category ? humanize(category) : ""}
                  selectedOptions={category ? [category] : []}
                  placeholder="Choose a category (optional)"
                  onOptionSelect={(_, d) => setCategory(d.optionValue ?? "")}
                >
                  {CATEGORIES.map((c) => <Option key={c} value={c}>{humanize(c)}</Option>)}
                </Dropdown>
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button appearance="primary" type="submit" disabled={create.isPending || !title || !description}>
                Create ticket
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
