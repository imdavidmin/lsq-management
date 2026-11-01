import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../../api/client";
import type { SiteInfo, Survey, SurveyResponse } from "../../api/types";

export const useSurveys = () =>
  useQuery({ queryKey: ["surveys"], queryFn: () => request<Survey[]>("/surveys") });

export function useSetSurveyClosed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, closed }: { id: number; closed: boolean }) =>
      request<Survey>(`/surveys/${id}`, { method: "PATCH", body: { closed } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["surveys"] }),
  });
}

export const useResponses = (surveyId: number) =>
  useQuery({
    queryKey: ["responses", surveyId],
    queryFn: () => request<SurveyResponse[]>(`/surveys/${surveyId}/responses`),
  });

export function useFlagOutlier(surveyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rid, is_outlier }: { rid: number; is_outlier: boolean }) =>
      request<SurveyResponse>(`/surveys/${surveyId}/responses/${rid}`, {
        method: "PATCH",
        body: { is_outlier },
      }),
    // Outlier counts on the survey change too.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["responses", surveyId] });
      void qc.invalidateQueries({ queryKey: ["surveys"] });
    },
  });
}

export const useSiteInfo = () =>
  useQuery({ queryKey: ["site-info"], queryFn: () => request<SiteInfo>("/site-info") });

export function useSaveSiteInfo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: string) => request<SiteInfo>("/site-info", { method: "PUT", body: { value } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["site-info"] }),
  });
}
