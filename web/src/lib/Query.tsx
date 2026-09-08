import type { UseQueryResult } from "@tanstack/react-query";
import { MessageBar, MessageBarBody, Spinner } from "@fluentui/react-components";
import type { ReactNode } from "react";

// Uniform loading/error handling for a query-backed view.
export function Query<T>({
  q,
  children,
}: {
  q: UseQueryResult<T>;
  children: (data: T) => ReactNode;
}) {
  if (q.isLoading) return <Spinner label="Loading…" />;
  if (q.isError)
    return (
      <MessageBar intent="error">
        <MessageBarBody>{(q.error as Error)?.message ?? "Failed to load."}</MessageBarBody>
      </MessageBar>
    );
  return <>{children(q.data as T)}</>;
}
