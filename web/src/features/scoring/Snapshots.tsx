import { Button, Link, Text, Title2, makeStyles, tokens } from "@fluentui/react-components";
import { Can } from "../../auth/Can";
import { Query } from "../../lib/Query";
import { dateTime } from "../../lib/format";
import { span } from "./Dashboard";
import { useScore, useSnapshots, useTakeSnapshot } from "./api";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, alignItems: "flex-start" },
});

// The just-ended year's official figures, frozen to R2 by the board (D21).
export function Snapshots() {
  const s = useStyles();
  const q = useSnapshots();
  const take = useTakeSnapshot();
  const cur = useScore().data?.service_year; // the server decides the current service year
  return (
    <div className={s.root}>
      <Title2>Year-end snapshots</Title2>
      {cur != null && (
        <Can perm="score:snapshot">
          <Button disabled={take.isPending} onClick={() => take.mutate(cur - 1)}>
            Take year-end snapshot for {span(cur - 1)}
          </Button>
        </Can>
      )}
      <Query q={q}>
        {(snaps) =>
          snaps.length === 0 ? (
            <Text size={200}>No snapshots yet.</Text>
          ) : (
            <>
              {snaps.map((x) => (
                <Link key={x.id} href={`/api/score/snapshots/${x.id}`}>
                  Service year {span(x.service_year!)} · taken {dateTime(x.taken_at)}
                </Link>
              ))}
            </>
          )
        }
      </Query>
    </div>
  );
}
