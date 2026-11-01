import type { Meta, StoryObj } from "@storybook/react";
import { AlphaOverlay } from "./AlphaOverlay";

const meta: Meta<typeof AlphaOverlay> = {
  title: "Components/AlphaOverlay",
  component: AlphaOverlay,
};
export default meta;
type Story = StoryObj<typeof AlphaOverlay>;

export const Default: Story = {
  args: {
    view: `story-${Date.now()}`,
    children: (
      <div>
        <h2>Monthly report</h2>
        {Array.from({ length: 12 }, (_, i) => <p key={i}>Placeholder row {i + 1}</p>)}
      </div>
    ),
  },
};
