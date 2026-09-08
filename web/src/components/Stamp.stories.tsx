import type { Meta, StoryObj } from "@storybook/react";
import { Stamp } from "./Stamp";

const meta: Meta<typeof Stamp> = {
  title: "Components/Stamp",
  component: Stamp,
};
export default meta;
type Story = StoryObj<typeof Stamp>;

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

export const Recent: Story = {
  args: { at: daysAgo(3) },
};

export const LongAgo: Story = {
  args: { at: daysAgo(90) },
};

export const Large: Story = {
  args: { at: daysAgo(1), size: 300 },
};

export const Empty: Story = {
  args: { at: null },
};
