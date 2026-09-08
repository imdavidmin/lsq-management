import type { Meta, StoryObj } from "@storybook/react";
import type { Event, TicketDetail } from "../api/types";
import { TicketDrawer } from "./TicketDrawer";

const meta: Meta<typeof TicketDrawer> = {
  title: "Components/TicketDrawer",
  component: TicketDrawer,
  args: { open: true, onOpenChange: () => {}, onExpand: () => {} },
};
export default meta;
type Story = StoryObj<typeof TicketDrawer>;

const events: Event[] = [
  { id: 1, type: "comment", body: "Kitchen tap dripping constantly.", at: "2026-08-14T16:40:00Z", source: "ui" },
  { id: 2, type: "status", from_value: "open", to_value: "pending_3rd_party", body: "Plumber booked.", at: "2026-08-15T08:00:00Z", source: "ui" },
];

const ticket: TicketDetail = {
  id: 2,
  title: "Leaking tap in Flat 1",
  status: "pending_3rd_party",
  category: "reactive_fault",
  classified_by: "agent",
  needs_contractor: true,
  is_duplicate: false,
  building_id: 1,
  unit_id: 1,
  created_at: "2026-08-14T16:40:00Z",
  events,
};

export const Open: Story = { args: { ticket } };
