import type { Meta, StoryObj } from "@storybook/react";
import { Text } from "@fluentui/react-components";
import { CheckmarkCircle20Filled, Warning20Filled } from "@fluentui/react-icons";
import { CollapsibleGroup } from "./CollapsibleGroup";

const meta: Meta<typeof CollapsibleGroup> = {
  title: "Components/CollapsibleGroup",
  component: CollapsibleGroup,
};
export default meta;
type Story = StoryObj<typeof CollapsibleGroup>;

export const Danger: Story = {
  args: {
    title: "Inactive — no activity in 14+ days",
    count: 2,
    tone: "danger",
    icon: <Warning20Filled />,
    children: <Text>Ticket cards render here.</Text>,
  },
};

export const CompletedCollapsed: Story = {
  args: {
    title: "Completed",
    count: 12,
    tone: "success",
    icon: <CheckmarkCircle20Filled />,
    defaultOpen: false,
    children: <Text>Ticket cards render here.</Text>,
  },
};

export const Empty: Story = {
  args: { title: "Pending", count: 0, tone: "warning" },
};
