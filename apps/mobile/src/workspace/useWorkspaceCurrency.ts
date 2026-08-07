import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { apiFetch, bootstrapActiveWorkspace } from "../api/client";
import { getActiveWorkspaceId } from "./active";

export function useWorkspaceCurrency(): string {
  const [currency, setCurrency] = useState("CAD");

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const workspaceId =
            (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
          if (!workspaceId) return;
          const data = await apiFetch<{
            workspaces: Array<{ id: string; currency: string }>;
          }>("/workspaces");
          const workspace = data.workspaces.find((item) => item.id === workspaceId);
          if (!cancelled && workspace) setCurrency(workspace.currency);
        } catch {
          // Keep the safe default until workspace metadata can be refreshed.
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  return currency;
}
