import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title1,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowDownload24Regular } from "@fluentui/react-icons";
import { useAuth } from "../../auth/AuthProvider";

const useStyles = makeStyles({
  root: { display: "grid", gap: tokens.spacingVerticalL, maxWidth: "640px" },
  fields: { display: "grid", gridTemplateColumns: "max-content 1fr", gap: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}` },
});

// The caller's own personal data, straight from /auth/me, plus the GDPR read-trail download (D22).
export function MyAccountPage() {
  const s = useStyles();
  const { identity } = useAuth();
  const account = identity?.account;

  return (
    <div className={s.root}>
      <Title1>My account</Title1>

      <div className={s.fields}>
        <Text weight="semibold">Name</Text>
        <Text>{account?.name}</Text>
        <Text weight="semibold">Email</Text>
        <Text>{account?.email}</Text>
        <Text weight="semibold">Status</Text>
        <Text>{account?.active ? "Active" : "Inactive"}</Text>
      </div>

      <Title3>Access</Title3>
      <Table size="small">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Role</TableHeaderCell>
            <TableHeaderCell>Scope</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {identity?.grants?.map((g) => (
            <TableRow key={g.id}>
              <TableCell>{g.role_key}</TableCell>
              <TableCell>
                <Badge appearance="tint">{g.scope_type}</Badge> {g.scope_id != null && `#${g.scope_id}`}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Title3>Who has viewed my data</Title3>
      <Text>Download a record of every time someone viewed your personal details, and who it was.</Text>
      <div>
        <Button as="a" href="/api/auth/me/access-log" download="access-log.csv" icon={<ArrowDownload24Regular />}>
          Download data access records
        </Button>
      </div>
    </div>
  );
}
