import { useCallback, useEffect, useState } from "react";
import type { WorkspaceSummary } from "@fina/shared";
import { bootstrapActiveWorkspaceSummary } from "../api/client";
import { subscribeActiveWorkspace } from "./active";

export function useActiveWorkspace(): { workspace: WorkspaceSummary | null; loading: boolean; reload: () => void } {
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    bootstrapActiveWorkspaceSummary()
      .then(setWorkspace)
      .catch(() => setWorkspace(null))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
    return subscribeActiveWorkspace(() => load());
  }, [load]);
  return { workspace, loading, reload: load };
}
