import type { Meta, StoryObj } from "@storybook/react";
import type { Event, Ticket } from "../api/types";
import { TicketCard } from "./TicketCard";

const meta: Meta<typeof TicketCard> = {
  title: "Components/TicketCard",
  component: TicketCard,
};
export default meta;
type Story = StoryObj<typeof TicketCard>;

const events: Event[] = [
  { id: 1, type: "comment", body: "Graffiti on the second-floor stairwell wall.", at: "2026-08-05T09:00:00Z", source: "ui" },
];

const base: Ticket & { events: Event[] } = {
  id: 5,
  title: "Graffiti on stairwell",
  status: "open",
  category: "site_defect",
  classified_by: "agent",
  needs_contractor: false,
  is_duplicate: false,
  created_at: "2026-08-01T09:00:00Z",
  events,
};

export const Default: Story = { args: { ticket: base } };

export const NeedsContractor: Story = {
  args: { ticket: { ...base, status: "pending_3rd_party", needs_contractor: true } },
};
