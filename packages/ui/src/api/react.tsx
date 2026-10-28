// React access to the API client.
import { createContext, useContext, type ReactNode } from "react";
import type { ApiClient } from "./client";

const ClientContext = createContext<ApiClient | null>(null);

export function ApiClientProvider({
  client,
  children,
}: {
  client: ApiClient;
  children: ReactNode;
}) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

/** Returns the client from the nearest `ApiClientProvider`. */
export function useApiClient(): ApiClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useApiClient needs an ApiClientProvider.");
  return client;
}
