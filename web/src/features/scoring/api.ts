import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../../api/client";
import type {
  Metric,
  MetricValue,
  MetricValueCreate,
  MonthlyReport,
  Score,
} from "../../api/types";

export const useScore = (year?: number) =>
  useQuery({
    queryKey: ["score", year ?? "current"],
    queryFn: () => request<Score>("/score", { query: { year } }),
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

export function usePatchMetric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, ...body }: Partial<Metric> & { key: string }) =>
      request<Metric>(`/metrics/${key}`, { method: "PATCH", body }),
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
