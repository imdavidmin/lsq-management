import { Text, Tooltip, makeStyles } from "@fluentui/react-components";
import { dateTime, relativeTime } from "../lib/format";

const useStyles = makeStyles({
  hint: { textDecoration: "underline dashed", textUnderlineOffset: "2px", cursor: "help" },
});

// Relative time ("3 days ago") with the exact timestamp on hover; dashed
// underline hints at the tooltip. Reused wherever a timestamp is shown.
export function Stamp({ at, size = 200 }: { at: string | null | undefined; size?: 100 | 200 | 300 }) {
  const s = useStyles();
  if (!at) return null;
  return (
    <Tooltip content={dateTime(at)} relationship="label">
      <Text size={size} className={s.hint}>{relativeTime(at)}</Text>
    </Tooltip>
  );
}
