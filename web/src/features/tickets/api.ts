import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../../api/client";
import type { Event, Ticket, TicketCreate, TicketDetail } from "../../api/types";

export type TicketFilters = {
  status?: string;
  category?: string;
  building_id?: number;
  unit_id?: number;
  mine?: boolean;
  page?: number;
  per_page?: number;
};

type TicketList = { data: TicketDetail[]; page: number; total: number };

export const useTickets = (filters: TicketFilters) =>
  useQuery({
    queryKey: ["tickets", filters],
    queryFn: () => request<TicketList>("/tickets", { query: filters }),
  });

export const useTicket = (id: number) =>
  useQuery({
    queryKey: ["ticket", id],
    queryFn: () => request<TicketDetail>(`/tickets/${id}`),
  });

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TicketCreate) =>
      request<Ticket>("/tickets", { method: "POST", body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tickets"] }),
  });
}

export function usePatchTicket(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Pick<Ticket, "status" | "category" | "needs_contractor" | "is_duplicate">>) =>
      request<Ticket>(`/tickets/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", id] });
      void qc.invalidateQueries({ queryKey: ["tickets"] });
    },
  });
}

export function useAddComment(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      request<Event>(`/tickets/${id}/events`, { method: "POST", body: { body } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["ticket", id] }),
  });
}
