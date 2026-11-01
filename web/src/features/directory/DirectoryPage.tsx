import { useMemo, useState } from "react";
import {
  Badge,
  Button,
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
import { Dismiss20Regular, Eye20Regular, PeopleTeam20Regular, PersonAdd20Regular } from "@fluentui/react-icons";
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
  useBuildings,
  useCreateAccount,
  useCreateGrant,
  useCreateOrganization,
  useCreateRole,
  useDeleteGrant,
  useOrganizations,
  usePatchSender,
  useRevealEmail,
  useRevealUnits,
  useRoles,
  useSenders,
  useSetRolePermissions,
  useUnits,
} from "./api";
import type { Grant, Role, ScopeType } from "../../api/types";

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

// Create-resident dialog: collect identity + household, then POST /accounts,
// which creates the account, a resident grant for the unit, and emails an
// activation invite (passwordless — the email points them at sign-in).
function NewUserDialog() {
  const s = useStyles();
  const create = useCreateAccount();
  const buildings = useBuildings();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [buildingId, setBuildingId] = useState<number | null>(null);
  const [unitId, setUnitId] = useState<number | null>(null);
  const units = useUnits(buildingId);

  const reset = () => { setName(""); setEmail(""); setBuildingId(null); setUnitId(null); };
  const canSend = !!name && !!email && unitId != null && !create.isPending;
  const send = () =>
    create.mutate(
      { name, email, unit_id: unitId },
      { onSuccess: () => { reset(); setOpen(false); } },
    );

  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) reset(); }}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="primary" icon={<PersonAdd20Regular />}>Create new user</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Invite a resident</DialogTitle>
          <DialogContent className={s.dialogForm}>
            <Field label="Full name" required>
              <Input value={name} onChange={(_, d) => setName(d.value)} />
            </Field>
            <Field label="Email" required>
              <Input type="email" value={email} onChange={(_, d) => setEmail(d.value)} />
            </Field>
            <Field label="Building" required>
              <Dropdown
                placeholder="Select building"
                value={buildings.data?.find((b) => b.id === buildingId)?.name ?? ""}
                selectedOptions={buildingId != null ? [String(buildingId)] : []}
                onOptionSelect={(_, d) => { setBuildingId(Number(d.optionValue)); setUnitId(null); }}
              >
                {(buildings.data ?? []).map((b) => (
                  <Option key={b.id} value={String(b.id)} text={b.name ?? ""}>{b.name}</Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="Unit" required>
              <Dropdown
                placeholder="Select unit"
                disabled={buildingId == null}
                value={units.data?.find((u) => u.id === unitId)?.label ?? ""}
                selectedOptions={unitId != null ? [String(unitId)] : []}
                onOptionSelect={(_, d) => setUnitId(Number(d.optionValue))}
              >
                {(units.data ?? []).map((u) => (
                  <Option key={u.id} value={String(u.id)} text={u.label ?? ""}>{u.label}</Option>
                ))}
              </Dropdown>
            </Field>
            {create.isError && (
              <Text style={{ color: tokens.colorPaletteRedForeground1 }}>
                {(create.error as Error)?.message ?? "Could not create the account."}
              </Text>
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
function SendersPanel() {
  const q = useSenders("new");
  const orgs = useOrganizations();
  const patch = usePatchSender();
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
                <TableHeaderCell>Link to org</TableHeaderCell>
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
                      placeholder="Select org"
                      onOptionSelect={(_, d) =>
                        patch.mutate({ id: s.id!, org_id: Number(d.optionValue), status: "linked" })
                      }
                    >
                      {(orgs.data ?? []).map((o) => (
                        <Option key={o.id} value={String(o.id)} text={o.name ?? ""}>{o.name}</Option>
                      ))}
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

// Side panel to view/assign a single account's role grants, scoped to a
// building / unit / org / the whole estate (D18). Assign/revoke needs grant:manage.
// Ticket-scoped grants are per-ticket sharing (UJ-08), managed from a ticket, not here.
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
        {has("role:read") && <Tab value="permissions">Permissions</Tab>}
      </TabList>
      {tab === "accounts" && <AccountsPanel />}
      {tab === "senders" && <SendersPanel />}
      {tab === "orgs" && <OrgsPanel />}
      {tab === "permissions" && <PermissionsPanel />}
    </div>
  );
}
