import { useEffect, useState } from "react";
import { marked } from "marked";
import {
  Button,
  Field,
  Textarea,
  Text,
  Title1,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { EditRegular } from "@fluentui/react-icons";
import { Can } from "../../auth/Can";
import { Query } from "../../lib/Query";
import { dateTime } from "../../lib/format";
import { useSiteInfo, useSaveSiteInfo } from "./api";

const useStyles = makeStyles({
  head: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalM },
  // Rendered markdown, themed with Fluent tokens.
  body: {
    marginTop: tokens.spacingVerticalM,
    lineHeight: tokens.lineHeightBase400,
    "& h1, & h2, & h3": { marginBlock: `${tokens.spacingVerticalL} ${tokens.spacingVerticalS}`, fontWeight: tokens.fontWeightSemibold },
    "& h2": { fontSize: tokens.fontSizeBase500 },
    "& h3": { fontSize: tokens.fontSizeBase400 },
    "& p, & ul, & ol": { marginBlock: tokens.spacingVerticalS },
    "& ul, & ol": { paddingInlineStart: tokens.spacingHorizontalXXL },
    "& a": { color: tokens.colorBrandForegroundLink },
    "& code": { fontFamily: tokens.fontFamilyMonospace, backgroundColor: tokens.colorNeutralBackground3, padding: "0 4px", borderRadius: tokens.borderRadiusSmall },
  },
  editor: { display: "grid", gap: tokens.spacingVerticalM, maxWidth: "640px", marginTop: tokens.spacingVerticalL },
  actions: { display: "flex", gap: tokens.spacingHorizontalS },
});

export function SiteInfoPage() {
  const s = useStyles();
  const q = useSiteInfo();
  const save = useSaveSiteInfo();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // Seed the editor from the loaded value once it arrives.
  useEffect(() => {
    if (q.data && !editing) setDraft(q.data.value ?? "");
  }, [q.data, editing]);

  return (
    <div>
      <Query q={q}>
        {(info) => (
          <>
            <div className={s.head}>
              <Title1>Site information</Title1>
              {!editing && (
                <Can perm="config:manage">
                  <Tooltip content="Edit site information" relationship="label">
                    <Button appearance="subtle" icon={<EditRegular />} onClick={() => setEditing(true)} />
                  </Tooltip>
                </Can>
              )}
            </div>

            {editing ? (
              <div className={s.editor}>
                <Field label="Site information (markdown)">
                  <Textarea value={draft} onChange={(_, d) => setDraft(d.value)} rows={16} />
                </Field>
                <div className={s.actions}>
                  <Button
                    appearance="primary"
                    disabled={save.isPending || draft === (info.value ?? "")}
                    onClick={() => save.mutate(draft, { onSuccess: () => setEditing(false) })}
                  >
                    Save
                  </Button>
                  <Button appearance="secondary" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {/* Admin-authored (trusted) markdown → HTML. */}
                <div className={s.body} dangerouslySetInnerHTML={{ __html: marked.parse(info.value || "_No site information yet._") as string }} />
                {info.updated_at && <Text size={200}>Updated {dateTime(info.updated_at)}</Text>}
              </>
            )}
          </>
        )}
      </Query>
    </div>
  );
}
