import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Combobox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Dropdown,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  Input,
  Option,
  OptionGroup,
  OverlayDrawer,
  Spinner,
  Text,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Tab,
  TabList,
  Title1,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Delete20Regular, Dismiss20Regular, Eye20Regular, PeopleTeam20Regular, PersonAdd20Regular } from "@fluentui/react-icons";
import type { ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { agTheme } from "../../lib/grid";
import { usePermissions } from "../../auth/AuthProvider";
import { useThemeMode } from "../../theme-provider";
import { Can } from "../../auth/Can";
import { Query } from "../../lib/Query";
import { dateTime } from "../../lib/format";
import {
  useAccount,
  useAccounts,
  useAddAccountEmail,
  useBuildings,
  useCreateAccount,
  useCreateGrant,
  useCreateOrganization,
  useCreateRole,
  useDeleteAccount,
  useDeleteGrant,
  useDeleteMailAlias,
  useLinkSenderToAccount,
  useMailAliases,
  useOrganizations,
  usePatchSender,
  useRemoveAccountEmail,
  useRevealEmail,
  useRevealUnits,
  useRoles,
  useSaveMailAlias,
  useSenders,
  useSetRolePermissions,
  useUnits,
} from "./api";
import type { Grant, MailAlias, Role, ScopeType } from "../../api/types";

const useStyles = makeStyles({
  tabs: { marginBottom: tokens.spacingVerticalL },
  form: { display: "flex", gap: tokens.spacingHorizontalM, alignItems: "end", marginBottom: tokens.spacingVerticalL },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: tokens.spacingVerticalM,
  },
  dialogForm: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  error: { color: tokens.colorPaletteRedForeground1 },
  deleteUser: { marginTop: tokens.spacingVerticalXXL, color: tokens.colorPaletteRedForeground1 },
  danger: { backgroundColor: tokens.colorPaletteRedBackground3, ":hover": { backgroundColor: tokens.colorPaletteRedForeground1 } },
  grid: { width: "100%", height: "70vh" },
  drawer: { width: "420px" },
  // Assign form inside the narrow drawer: stack vertically, full-width controls,
  // so the role/scope dropdowns + button don't overflow and force a scrollbar.
  drawerForm: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    marginTop: tokens.spacingVerticalL,
    alignItems: "stretch",
    // Fluent Dropdowns default to an intrinsic width; make them fill the column.
    "& [role='combobox']": { minWidth: 0, width: "100%" },
  },
});

type AccountRow = { id: number; name: string; active: boolean; roles: string; buildings: string };

// Masked-until-click cell. The reveal button fires an audited read
// (GET /accounts/{id}?reveal=email|units) and shows the value once.
function RevealCell({ isFetching, value, onReveal }: { isFetching: boolean; value?: string; onReveal: () => void }) {
  if (value !== undefined) return <span>{value || "—"}</span>;
  return (
    <Button size="small" appearance="subtle" icon={<Eye20Regular />} disabled={isFetching} onClick={onReveal}>
      {isFetching ? "Revealing…" : "•••• reveal"}
    </Button>
  );
}

function EmailCell({ id }: { id: number }) {
  const [revealed, setRevealed] = useState(false);
  const q = useRevealEmail(id, revealed);
  return <RevealCell isFetching={q.isFetching} value={q.data?.email} onReveal={() => setRevealed(true)} />;
}

// Household PII: masked until an explicit, audited reveal — same gate as email.
function UnitCell({ id }: { id: number }) {
  const [revealed, setRevealed] = useState(false);
  const q = useRevealUnits(id, revealed);
  return <RevealCell isFetching={q.isFetching} value={q.data?.units?.join(", ")} onReveal={() => setRevealed(true)} />;
}

// Roles that live on the estate pick a building + typed unit (board members are
// residents too); contractors belong to an organization; other staff need neither.
const HOME_ROLES = ["resident", "board"];

// Create-user dialog → POST /accounts, which creates the account + grants for
// the chosen role and emails a passwordless invite (the email points at sign-in).
function NewUserDialog() {
  const s = useStyles();
  const create = useCreateAccount();
  const roles = useRoles();
  const buildings = useBuildings();
  const orgs = useOrganizations();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState("resident");
  const [buildingId, setBuildingId] = useState<number | null>(null);
  const [unit, setUnit] = useState("");
  const [orgId, setOrgId] = useState<number | null>(null);
  const units = useUnits(buildingId);

  const needsHome = HOME_ROLES.includes(roleKey);
  const needsOrg = roleKey === "contractor";
  const reset = () => {
    setName(""); setEmail(""); setRoleKey("resident"); setBuildingId(null); setUnit(""); setOrgId(null);
  };
  const canSend =
    !!name && !!email && (!needsHome || (buildingId != null && !!unit.trim())) && (!needsOrg || orgId != null) &&
    !create.isPending;
  const send = () =>
    create.mutate(
      {
        name,
        email,
        role_key: roleKey,
        ...(needsHome && { building_id: buildingId, unit: unit.trim() }),
        ...(needsOrg && { org_id: orgId }),
      },
      { onSuccess: () => { reset(); setOpen(false); } },
    );

  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) reset(); }}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="primary" icon={<PersonAdd20Regular />}>Create new user</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Invite a user</DialogTitle>
          <DialogContent className={s.dialogForm}>
            <Field label="Full name" required>
              <Input value={name} onChange={(_, d) => setName(d.value)} />
            </Field>
            <Field label="Email" required>
              <Input type="email" value={email} onChange={(_, d) => setEmail(d.value)} />
            </Field>
            <Field label="Role" required>
              <Dropdown
                value={roles.data?.find((r) => r.key === roleKey)?.name ?? ""}
                selectedOptions={[roleKey]}
                onOptionSelect={(_, d) => setRoleKey(d.optionValue!)}
              >
                {(roles.data ?? []).map((r) => (
                  <Option key={r.key} value={r.key!} text={r.name ?? ""}>{r.name}</Option>
                ))}
              </Dropdown>
            </Field>
            {needsHome && (
              <>
                <Field label="Building" required>
                  <Dropdown
                    placeholder="Select building"
                    value={buildings.data?.find((b) => b.id === buildingId)?.name ?? ""}
                    selectedOptions={buildingId != null ? [String(buildingId)] : []}
                    onOptionSelect={(_, d) => setBuildingId(Number(d.optionValue))}
                  >
                    {(buildings.data ?? []).map((b) => (
                      <Option key={b.id} value={String(b.id)} text={b.name ?? ""}>{b.name}</Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="Unit" required hint="Type the flat, e.g. Flat 12 — new units are added automatically.">
                  <Combobox
                    freeform
                    placeholder="e.g. Flat 12"
                    disabled={buildingId == null}
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    onOptionSelect={(_, d) => setUnit(d.optionText ?? "")}
                  >
                    {(units.data ?? [])
                      .filter((u) => u.label?.toLowerCase().includes(unit.toLowerCase()))
                      .map((u) => (
                        <Option key={u.id} text={u.label ?? ""}>{u.label}</Option>
                      ))}
                  </Combobox>
                </Field>
              </>
            )}
            {needsOrg && (
              <Field label="Organization" required>
                <Dropdown
                  placeholder="Select contractor"
                  value={orgs.data?.find((o) => o.id === orgId)?.name ?? ""}
                  selectedOptions={orgId != null ? [String(orgId)] : []}
                  onOptionSelect={(_, d) => setOrgId(Number(d.optionValue))}
                >
                  {(orgs.data ?? []).filter((o) => o.kind === "contractor").map((o) => (
                    <Option key={o.id} value={String(o.id)} text={o.name ?? ""}>{o.name}</Option>
                  ))}
                </Dropdown>
              </Field>
            )}
            {create.isError && (
              <Text className={s.error}>{(create.error as Error)?.message ?? "Could not create the account."}</Text>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Cancel</Button>
            </DialogTrigger>
            <Button appearance="primary" disabled={!canSend} onClick={send}>
              {create.isPending ? "Sending…" : "Send invitation"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// Accounts grid: identity + coarse building(s) only. Email is reveal-gated per
// row; "Manage access" opens a drawer to assign/revoke (and reveal unit there).
function AccountsPanel() {
  const s = useStyles();
  const { dark } = useThemeMode();
  const accounts = useAccounts();
  const { has } = usePermissions();
  const canGrants = has("grant:read");
  const [manageId, setManageId] = useState<number | null>(null);

  const rows = useMemo<AccountRow[]>(
    () =>
      (accounts.data ?? []).map((a) => ({
        id: a.id!,
        name: a.name!,
        active: !!a.active,
        roles: (a.roles ?? []).join(", "),
        buildings: (a.buildings ?? []).join(", "),
      })),
    [accounts.data],
  );

  const cols = useMemo<ColDef<AccountRow>[]>(() => {
    const c: ColDef<AccountRow>[] = [
      { field: "name", flex: 1, minWidth: 140 },
      { headerName: "Active", maxWidth: 100, valueGetter: (p) => (p.data?.active ? "yes" : "no") },
      { field: "roles", headerName: "Roles", flex: 1, minWidth: 140 },
      { field: "buildings", headerName: "Buildings", flex: 1, minWidth: 160 },
      {
        headerName: "Unit",
        flex: 1,
        minWidth: 160,
        sortable: false,
        filter: false,
        cellRenderer: (p: { data?: AccountRow }) => (p.data ? <UnitCell id={p.data.id} /> : null),
      },
      {
        headerName: "Email",
        flex: 1,
        minWidth: 200,
        sortable: false,
        filter: false,
        cellRenderer: (p: { data?: AccountRow }) => (p.data ? <EmailCell id={p.data.id} /> : null),
      },
    ];
    if (canGrants)
      c.push({
        headerName: "",
        maxWidth: 170,
        sortable: false,
        filter: false,
        cellRenderer: (p: { data?: AccountRow }) => (
          <Button size="small" icon={<PeopleTeam20Regular />} onClick={() => p.data && setManageId(p.data.id)}>
            Manage access
          </Button>
        ),
      });
    return c;
  }, [canGrants]);

  return (
    <div>
      <div className={s.header}>
        <Title3>Accounts</Title3>
        <Can perm="account:manage">
          <NewUserDialog />
        </Can>
      </div>
      {accounts.isLoading ? (
        <Spinner label="Loading…" />
      ) : (
        <div className={s.grid}>
          <AgGridReact<AccountRow>
            theme={agTheme(dark)}
            rowData={rows}
            columnDefs={cols}
            defaultColDef={{ sortable: true, filter: true, resizable: true }}
          />
        </div>
      )}
      {canGrants && (
        <AccessDrawer accountId={manageId} onClose={() => setManageId(null)} />
      )}
    </div>
  );
}

// UJ-07: unknown-sender queue. Link a pending sender to an org, or ignore it.
// Unknown senders: link an email to a person (D29) or an address/domain to an org.
function SendersPanel() {
  const q = useSenders("new");
  const orgs = useOrganizations();
  const people = useAccounts();
  const patch = usePatchSender();
  const link = useLinkSenderToAccount();
  return (
    <div>
      <Title3>Unknown senders</Title3>
      <Query q={q}>
        {(senders) => (
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Match</TableHeaderCell>
                <TableHeaderCell>Hits</TableHeaderCell>
                <TableHeaderCell>Last seen</TableHeaderCell>
                <TableHeaderCell>Link to</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {senders.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{s.match_type}: {s.match_value}</TableCell>
                  <TableCell>{s.hit_count}</TableCell>
                  <TableCell>{dateTime(s.last_seen)}</TableCell>
                  <TableCell>
                    <Dropdown
                      placeholder="Person or organization"
                      onOptionSelect={(_, d) => {
                        const [kind, id] = (d.optionValue ?? "").split(":");
                        if (kind === "a") link.mutate({ id: s.id!, account_id: Number(id) });
                        else patch.mutate({ id: s.id!, org_id: Number(id), status: "linked" });
                      }}
                    >
                      {s.match_type === "email" && (
                        <OptionGroup label="People">
                          {(people.data ?? []).map((a) => (
                            <Option key={`a${a.id}`} value={`a:${a.id}`} text={a.name ?? ""}>{a.name}</Option>
                          ))}
                        </OptionGroup>
                      )}
                      <OptionGroup label="Organizations">
                        {(orgs.data ?? []).map((o) => (
                          <Option key={`o${o.id}`} value={`o:${o.id}`} text={o.name ?? ""}>{o.name}</Option>
                        ))}
                      </OptionGroup>
                    </Dropdown>
                  </TableCell>
                  <TableCell>
                    <Button size="small" onClick={() => patch.mutate({ id: s.id!, status: "ignored" })}>
                      Ignore
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Query>
    </div>
  );
}

function OrgsPanel() {
  const s = useStyles();
  const q = useOrganizations();
  const create = useCreateOrganization();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"agent" | "contractor">("contractor");
  return (
    <div>
      <Title3>Organizations</Title3>
      <div className={s.form}>
        <Field label="Name"><Input value={name} onChange={(_, d) => setName(d.value)} /></Field>
        <Field label="Kind">
          <Dropdown value={kind} selectedOptions={[kind]} onOptionSelect={(_, d) => setKind(d.optionValue as "agent" | "contractor")}>
            <Option value="agent">agent</Option>
            <Option value="contractor">contractor</Option>
          </Dropdown>
        </Field>
        <Button appearance="primary" disabled={create.isPending || !name} onClick={() => create.mutate({ name, kind }, { onSuccess: () => setName("") })}>
          Add
        </Button>
      </div>
      <Query q={q}>
        {(orgs) => (
          <Table size="small">
            <TableHeader>
              <TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Kind</TableHeaderCell></TableRow>
            </TableHeader>
            <TableBody>
              {orgs.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>{o.name}</TableCell>
                  <TableCell><Badge appearance="tint">{o.kind}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Query>
    </div>
  );
}

// Split a comma/space-separated address list into a clean array.
const parseEmails = (text: string) => text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);

// Board-provisioned @lansburysquare.co.uk forwards (D26). The agent can read
// these (mail:read); only board/admin can change them (mail:manage).
function MailPanel() {
  const s = useStyles();
  const q = useMailAliases();
  const save = useSaveMailAlias();
  const remove = useDeleteMailAlias();
  const { has } = usePermissions();
  const canManage = has("mail:manage");
  const [localPart, setLocalPart] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  return (
    <div>
      <Title3>Email addresses</Title3>
      <Text block>
        Addresses on the main domain forward to the destinations listed. Cloudflare emails each new destination a
        verification link; mail only forwards once it's clicked.
      </Text>
      {canManage && (
        <div className={s.form}>
          <Field label="Address">
            <Input value={localPart} onChange={(_, d) => setLocalPart(d.value.toLowerCase())} contentAfter={<Text>@lansburysquare.co.uk</Text>} />
          </Field>
          <Field label="Forward to (comma-separated)">
            <Input value={forwardTo} onChange={(_, d) => setForwardTo(d.value)} />
          </Field>
          <Button
            appearance="primary"
            // PUT replaces, so an existing name is changed via Edit, not re-added.
            disabled={save.isPending || !localPart || !forwardTo || !!q.data?.some((a) => a.local_part === localPart)}
            onClick={() =>
              save.mutate(
                { local_part: localPart, forward_to: parseEmails(forwardTo) },
                { onSuccess: () => { setLocalPart(""); setForwardTo(""); } }
              )
            }
          >
            Add
          </Button>
        </div>
      )}
      {save.error && <Text block className={s.error}>{save.error.message}</Text>}
      <Query q={q}>
        {(aliases) => (
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Address</TableHeaderCell>
                <TableHeaderCell>Forwards to</TableHeaderCell>
                {canManage && <TableHeaderCell />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {aliases.map((a) => (
                <TableRow key={a.local_part}>
                  <TableCell>{a.address}</TableCell>
                  <TableCell>
                    {a.forward_to.map((d) => (
                      <div key={d.email}>
                        {d.email}{" "}
                        {d.verified === false && <Badge appearance="tint" color="warning">awaiting verification</Badge>}
                      </div>
                    ))}
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <EditAliasDialog alias={a} />{" "}
                      <Button size="small" disabled={remove.isPending} onClick={() => remove.mutate(a.local_part)}>Remove</Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Query>
    </div>
  );
}

function EditAliasDialog({ alias }: { alias: MailAlias }) {
  const s = useStyles();
  const save = useSaveMailAlias();
  const [open, setOpen] = useState(false);
  const [forwardTo, setForwardTo] = useState("");
  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (d.open) setForwardTo(alias.forward_to.map((f) => f.email).join(", ")); }}>
      <DialogTrigger disableButtonEnhancement>
        <Button size="small">Edit</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{alias.address}</DialogTitle>
          <DialogContent className={s.dialogForm}>
            <Field label="Forward to (comma-separated)" validationMessage={save.error?.message}>
              <Input value={forwardTo} onChange={(_, d) => setForwardTo(d.value)} />
            </Field>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement><Button>Cancel</Button></DialogTrigger>
            <Button
              appearance="primary"
              disabled={save.isPending || !forwardTo}
              onClick={() =>
                save.mutate(
                  { local_part: alias.local_part, forward_to: parseEmails(forwardTo) },
                  { onSuccess: () => setOpen(false) }
                )
              }
            >
              Save
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// Split a free-text permission list on whitespace/commas into a clean array.
const parsePerms = (text: string) =>
  [...new Set(text.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean))].sort();

// RBAC roles + their permission sets (D18). Edit requires role:manage.
function PermissionsPanel() {
  const s = useStyles();
  const q = useRoles();
  const create = useCreateRole();
  const { has } = usePermissions();
  const canManage = has("role:manage");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  return (
    <div>
      <Title3>Roles &amp; permissions</Title3>
      {canManage && (
        <div className={s.form}>
          <Field label="Key"><Input value={key} onChange={(_, d) => setKey(d.value)} /></Field>
          <Field label="Name"><Input value={name} onChange={(_, d) => setName(d.value)} /></Field>
          <Button
            appearance="primary"
            disabled={create.isPending || !key || !name}
            onClick={() => create.mutate({ key, name }, { onSuccess: () => { setKey(""); setName(""); } })}
          >
            Add role
          </Button>
        </div>
      )}
      <Query q={q}>
        {(roles) => (
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Role</TableHeaderCell>
                <TableHeaderCell>Permissions</TableHeaderCell>
                {canManage && <TableHeaderCell>Edit</TableHeaderCell>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map((r) => (
                <RoleRow key={r.key} role={r} canManage={canManage} />
              ))}
            </TableBody>
          </Table>
        )}
      </Query>
    </div>
  );
}

function RoleRow({ role, canManage }: { role: Role; canManage: boolean }) {
  const setPerms = useSetRolePermissions();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState((role.permissions ?? []).join(" "));
  return (
    <TableRow>
      <TableCell>{role.name} <Badge appearance="outline">{role.key}</Badge></TableCell>
      <TableCell>
        {editing ? (
          <Input
            value={text}
            onChange={(_, d) => setText(d.value)}
            placeholder="e.g. ticket:read ticket:* role:manage"
            style={{ width: "100%" }}
          />
        ) : (
          <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {(role.permissions ?? []).map((p) => (
              <Badge key={p} appearance="tint">{p}</Badge>
            ))}
            {(role.permissions ?? []).length === 0 && <em>none</em>}
          </span>
        )}
      </TableCell>
      {canManage && (
        <TableCell>
          {editing ? (
            <>
              <Button
                size="small"
                appearance="primary"
                disabled={setPerms.isPending}
                onClick={() =>
                  setPerms.mutate(
                    { key: role.key!, permissions: parsePerms(text) },
                    { onSuccess: () => setEditing(false) },
                  )
                }
              >
                Save
              </Button>{" "}
              <Button size="small" onClick={() => { setText((role.permissions ?? []).join(" ")); setEditing(false); }}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="small" onClick={() => setEditing(true)}>Edit</Button>
          )}
        </TableCell>
      )}
    </TableRow>
  );
}

const SCOPE_TYPES: ScopeType[] = ["estate", "building", "unit", "organization"];

// An account's email addresses: primary (login) + extra inbound ones (D29).
// Masked until an audited reveal, like the email column.
function EmailsSection({ accountId }: { accountId: number }) {
  const s = useStyles();
  const { has } = usePermissions();
  const canManage = has("account:manage");
  const [revealed, setRevealed] = useState(false);
  const q = useRevealEmail(accountId, revealed);
  const add = useAddAccountEmail();
  const remove = useRemoveAccountEmail();
  const [email, setEmail] = useState("");
  return (
    <div className={s.drawerForm}>
      <Title3>Email addresses</Title3>
      {!q.data ? (
        <RevealCell isFetching={q.isFetching} onReveal={() => setRevealed(true)} />
      ) : (
        <>
          <Text>{q.data.email} <Badge appearance="tint">login</Badge></Text>
          {(q.data.emails ?? []).map((e) => (
            <div key={e} className={s.header}>
              <Text>{e}</Text>
              {canManage && (
                <Button size="small" disabled={remove.isPending} onClick={() => remove.mutate({ id: accountId, email: e })}>
                  Remove
                </Button>
              )}
            </div>
          ))}
          {canManage && (
            <Field label="Add an address they email from" validationMessage={add.error?.message}>
              <Input value={email} onChange={(_, d) => setEmail(d.value)} />
            </Field>
          )}
          {canManage && (
            <Button
              disabled={add.isPending || !email}
              onClick={() => add.mutate({ id: accountId, email }, { onSuccess: () => setEmail("") })}
            >
              Add address
            </Button>
          )}
        </>
      )}
    </div>
  );
}

// Side panel to view/assign a single account's role grants, scoped to a
// building / unit / org / the whole estate (D18). Assign/revoke needs grant:manage.
// Ticket-scoped grants are per-ticket sharing (UJ-08), managed from a ticket, not here.
// Delete = move-out erasure (D30): irreversible, so behind a confirm dialog.
function DeleteUserButton({ accountId, name, onDeleted }: { accountId: number; name: string; onDeleted: () => void }) {
  const s = useStyles();
  const del = useDeleteAccount();
  return (
    <Dialog>
      <DialogTrigger disableButtonEnhancement>
        <Button className={s.deleteUser} icon={<Delete20Regular />}>Delete user</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogContent className={s.dialogForm}>
            <Text>
              This permanently removes their name, email and access. Their ticket history is kept and shown as
              "Resident of &lt;unit&gt;" (or their role, for staff). This can't be undone.
            </Text>
            {del.isError && <Text className={s.error}>{(del.error as Error)?.message ?? "Could not delete."}</Text>}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Cancel</Button>
            </DialogTrigger>
            <Button
              appearance="primary"
              className={s.danger}
              disabled={del.isPending}
              onClick={() => del.mutate(accountId, { onSuccess: onDeleted })}
            >
              {del.isPending ? "Deleting…" : "Delete user"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function AccessDrawer({ accountId, onClose }: { accountId: number | null; onClose: () => void }) {
  const s = useStyles();
  const { has } = usePermissions();
  const canManage = has("grant:manage");
  // Reveal units so unit-scoped grants are visible/revocable here (audited).
  const detailQ = useAccount(accountId, ["units"]);

  const roles = useRoles();
  const buildings = useBuildings();
  const orgs = useOrganizations();
  const del = useDeleteGrant();
  const create = useCreateGrant();

  const [roleKey, setRoleKey] = useState("");
  const [scopeType, setScopeType] = useState<ScopeType>("estate");
  const [buildingId, setBuildingId] = useState<number | null>(null);
  const [scopeId, setScopeId] = useState<number | null>(null);
  const units = useUnits(scopeType === "unit" ? buildingId : null);

  // Resolve a grant's scope to a human label; falls back to "type #id".
  const scopeLabel = (g: Grant) => {
    if (g.scope_type === "estate") return "estate";
    if (g.scope_type === "building")
      return buildings.data?.find((b) => b.id === g.scope_id)?.name ?? `building #${g.scope_id}`;
    if (g.scope_type === "organization")
      return orgs.data?.find((o) => o.id === g.scope_id)?.name ?? `org #${g.scope_id}`;
    return `${g.scope_type} #${g.scope_id}`;
  };

  const needsTarget = scopeType !== "estate";
  const canSubmit =
    !!roleKey && !create.isPending && (!needsTarget || scopeId != null);

  const submit = () => {
    if (accountId == null) return;
    create.mutate(
      { account_id: accountId, role_key: roleKey, scope_type: scopeType, scope_id: needsTarget ? scopeId : null },
      { onSuccess: () => { setRoleKey(""); setScopeType("estate"); setScopeId(null); setBuildingId(null); } },
    );
  };

  return (
    <OverlayDrawer
      position="end"
      modalType="non-modal"
      open={accountId != null}
      onOpenChange={(_, d) => !d.open && onClose()}
      className={s.drawer}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close" onClick={onClose} />}
        >
          {detailQ.data ? `Access · ${detailQ.data.name}` : "Access"}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
      {accountId != null && (
        <Query q={detailQ}>
          {(detail) => (
            <>
              <Table size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Role</TableHeaderCell>
                    <TableHeaderCell>Scope</TableHeaderCell>
                    {canManage && <TableHeaderCell />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(detail.grants ?? []).map((g) => (
                    <TableRow key={g.id}>
                      <TableCell>{g.role_key}</TableCell>
                      <TableCell><Badge appearance="tint">{g.scope_type}</Badge> {scopeLabel(g)}</TableCell>
                      {canManage && (
                        <TableCell>
                          <Button
                            size="small"
                            disabled={del.isPending}
                            onClick={() => del.mutate({ id: g.id!, account_id: accountId })}
                          >
                            Revoke
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                  {(detail.grants ?? []).length === 0 && (
                    <TableRow><TableCell>No grants yet.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>

              {canManage && (
                <div className={s.drawerForm}>
                  <Field label="Role">
                    <Dropdown
                      placeholder="Role"
                      selectedOptions={roleKey ? [roleKey] : []}
                      value={roles.data?.find((r) => r.key === roleKey)?.name ?? ""}
                      onOptionSelect={(_, d) => setRoleKey(String(d.optionValue))}
                    >
                      {(roles.data ?? []).map((r) => (
                        <Option key={r.key} value={r.key} text={r.name ?? ""}>{r.name}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field label="Scope">
                    <Dropdown
                      selectedOptions={[scopeType]}
                      value={scopeType}
                      onOptionSelect={(_, d) => { setScopeType(d.optionValue as ScopeType); setScopeId(null); setBuildingId(null); }}
                    >
                      {SCOPE_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
                    </Dropdown>
                  </Field>
                  {scopeType === "building" && (
                    <Field label="Building">
                      <Dropdown placeholder="Building" onOptionSelect={(_, d) => setScopeId(Number(d.optionValue))}>
                        {(buildings.data ?? []).map((b) => (
                          <Option key={b.id} value={String(b.id)} text={b.name ?? ""}>{b.name}</Option>
                        ))}
                      </Dropdown>
                    </Field>
                  )}
                  {scopeType === "organization" && (
                    <Field label="Organization">
                      <Dropdown placeholder="Organization" onOptionSelect={(_, d) => setScopeId(Number(d.optionValue))}>
                        {(orgs.data ?? []).map((o) => (
                          <Option key={o.id} value={String(o.id)} text={o.name ?? ""}>{o.name}</Option>
                        ))}
                      </Dropdown>
                    </Field>
                  )}
                  {scopeType === "unit" && (
                    <>
                      <Field label="Building">
                        <Dropdown placeholder="Building" onOptionSelect={(_, d) => { setBuildingId(Number(d.optionValue)); setScopeId(null); }}>
                          {(buildings.data ?? []).map((b) => (
                            <Option key={b.id} value={String(b.id)} text={b.name ?? ""}>{b.name}</Option>
                          ))}
                        </Dropdown>
                      </Field>
                      <Field label="Unit">
                        <Dropdown placeholder="Unit" disabled={buildingId == null} onOptionSelect={(_, d) => setScopeId(Number(d.optionValue))}>
                          {(units.data ?? []).map((u) => (
                            <Option key={u.id} value={String(u.id)} text={u.label ?? ""}>{u.label}</Option>
                          ))}
                        </Dropdown>
                      </Field>
                    </>
                  )}
                  <Button appearance="primary" disabled={!canSubmit} onClick={submit}>Assign</Button>
                </div>
              )}
              <EmailsSection accountId={accountId} />
              <Can perm="account:manage">
                <DeleteUserButton accountId={accountId} name={detail.name ?? ""} onDeleted={onClose} />
              </Can>
            </>
          )}
        </Query>
      )}
      </DrawerBody>
    </OverlayDrawer>
  );
}

export function DirectoryPage() {
  const s = useStyles();
  const { has } = usePermissions();
  const [tab, setTab] = useState("accounts");
  return (
    <div>
      <Title1>Directory</Title1>
      <TabList className={s.tabs} selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
        {has("account:read") && <Tab value="accounts">Accounts</Tab>}
        {has("sender:read") && <Tab value="senders">Unknown senders</Tab>}
        {has("org:read") && <Tab value="orgs">Organizations</Tab>}
        {has("mail:read") && <Tab value="mail">Email addresses</Tab>}
        {has("role:read") && <Tab value="permissions">Permissions</Tab>}
      </TabList>
      {tab === "accounts" && <AccountsPanel />}
      {tab === "senders" && <SendersPanel />}
      {tab === "orgs" && <OrgsPanel />}
      {tab === "mail" && <MailPanel />}
      {tab === "permissions" && <PermissionsPanel />}
    </div>
  );
}
