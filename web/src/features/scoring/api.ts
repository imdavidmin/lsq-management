import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../../api/client";
import type {
  Metric,
  MetricDetail,
  MetricValue,
  MetricValueCreate,
  MonthlyReport,
  Score,
  Sla,
  Snapshot,
} from "../../api/types";

export const useScore = (year?: number) =>
  useQuery({
    queryKey: ["score", year ?? "current"],
    queryFn: () => request<Score>("/score", { query: { year } }),
  });

export const useMetricDetail = (key: string, year?: number) =>
  useQuery({
    queryKey: ["score", year ?? "current", key],
    queryFn: () => request<MetricDetail>(`/score/metrics/${encodeURIComponent(key)}`, { query: { year } }),
  });

export const useMetrics = () =>
  useQuery({ queryKey: ["metrics"], queryFn: () => request<Metric[]>("/metrics") });

export const useMetricValues = (params: { year?: number; metric?: string }) =>
  useQuery({
    queryKey: ["metric-values", params],
    queryFn: () => request<MetricValue[]>("/metric-values", { query: params }),
  });

export const useMonthlyReport = (month: string, enabled: boolean) =>
  useQuery({
    queryKey: ["report", month],
    queryFn: () => request<MonthlyReport>("/reports/monthly", { query: { month } }),
    enabled,
  });

// One atomic bulk edit; the server rejects it unless the whole table is valid.
export function useSaveMetrics() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: (Partial<Metric> & { key: string })[]) =>
      request<Metric[]>("/metrics", { method: "PATCH", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["metrics"] });
      void qc.invalidateQueries({ queryKey: ["score"] });
    },
  });
}

// Manual entry AND board dispute are the same superseding insert (UJ-15/UJ-08).
export function useCreateMetricValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MetricValueCreate) =>
      request<MetricValue>("/metric-values", { method: "POST", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["metric-values"] });
      void qc.invalidateQueries({ queryKey: ["score"] });
    },
  });
}

export function useAttest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      request<MetricValue>(`/metric-values/${id}/attest`, { method: "PATCH" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["metric-values"] }),
  });
}

// A new SLA has no id yet; save POSTs it, otherwise PATCHes.
export type SlaDraft = Omit<Sla, "id"> & { id?: number };

export const useSlas = () =>
  useQuery({ queryKey: ["slas"], queryFn: () => request<Sla[]>("/slas") });

// No delete: deactivate instead (D21). Edits re-score on read, so invalidate the score too.
export function useSaveSla() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: SlaDraft) =>
      id == null
        ? request<Sla>("/slas", { method: "POST", body })
        : request<Sla>(`/slas/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["slas"] });
      void qc.invalidateQueries({ queryKey: ["score"] });
    },
  });
}

export const useSnapshots = () =>
  useQuery({ queryKey: ["snapshots"], queryFn: () => request<Snapshot[]>("/score/snapshots") });

export function useTakeSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (year: number) => request<Snapshot>("/score/snapshots", { method: "POST", body: { year } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["snapshots"] }),
  });
}
