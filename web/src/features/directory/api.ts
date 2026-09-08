import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../../api/client";
import type { Account, AccountDetail, AccountSummary, Building, GrantCreate, Organization, OrganizationCreate, Role, Sender, Unit } from "../../api/types";

// Minimised list (no email/unit) — the GDPR default. See docs/gdpr.md.
export const useAccounts = () =>
  useQuery({ queryKey: ["accounts"], queryFn: () => request<AccountSummary[]>("/accounts") });

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; name: string; unit_id?: number | null }) =>
      request<Account>("/accounts", { method: "POST", body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
}

export const useSenders = (status?: string) =>
  useQuery({
    queryKey: ["senders", status],
    queryFn: () => request<Sender[]>("/senders", { query: { status } }),
  });

export function usePatchSender() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; org_id?: number | null; status?: string }) =>
      request<Sender>(`/senders/${id}`, { method: "PATCH", body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["senders"] }),
  });
}

export const useOrganizations = () =>
  useQuery({ queryKey: ["organizations"], queryFn: () => request<Organization[]>("/organizations") });

export function useCreateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OrganizationCreate) =>
      request<Organization>("/organizations", { method: "POST", body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["organizations"] }),
  });
}

export const useRoles = () =>
  useQuery({ queryKey: ["roles"], queryFn: () => request<Role[]>("/roles") });

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { key: string; name: string }) =>
      request<Role>("/roles", { method: "POST", body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["roles"] }),
  });
}

export function useSetRolePermissions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, permissions }: { key: string; permissions: string[] }) =>
      request<Role>(`/roles/${key}/permissions`, { method: "PUT", body: { permissions } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["roles"] }),
  });
}

// Reveal-gated detail. Each `reveal` field unmasks PII and is audited server-side
// (docs/gdpr.md). The drawer reveals `units` so unit-scoped grants are manageable.
export const useAccount = (id: number | null | undefined, reveal: string[] = []) =>
  useQuery({
    queryKey: ["accounts", id, ...reveal],
    enabled: id != null,
    queryFn: () => request<AccountDetail>(`/accounts/${id}`, { query: { reveal: reveal.join(",") || undefined } }),
  });

// Lazily reveal one account's PII (email or unit). enabled=false until the
// reveal button is clicked, so nothing is fetched — or audited — up front.
const useReveal = (id: number, field: "email" | "units", enabled: boolean) =>
  useQuery({
    queryKey: ["accounts", id, field],
    enabled,
    queryFn: () => request<AccountDetail>(`/accounts/${id}`, { query: { reveal: field } }),
  });

export const useRevealEmail = (id: number, enabled: boolean) => useReveal(id, "email", enabled);
export const useRevealUnits = (id: number, enabled: boolean) => useReveal(id, "units", enabled);

export function useCreateGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GrantCreate) => request("/grants", { method: "POST", body }),
    onSuccess: (_r, v) => void qc.invalidateQueries({ queryKey: ["accounts", v.account_id] }),
  });
}

export function useDeleteGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: number; account_id: number }) =>
      request<void>(`/grants/${id}`, { method: "DELETE" }),
    onSuccess: (_r, v) => void qc.invalidateQueries({ queryKey: ["accounts", v.account_id] }),
  });
}

export const useBuildings = () =>
  useQuery({ queryKey: ["buildings"], queryFn: () => request<Building[]>("/buildings") });

export const useUnits = (buildingId: number | null | undefined) =>
  useQuery({
    queryKey: ["units", buildingId],
    enabled: buildingId != null,
    queryFn: () => request<Unit[]>(`/buildings/${buildingId}/units`),
  });
