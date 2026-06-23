import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ThreadActionsSheet } from "./ThreadActionsSheet";

type OpenArgs = {
  threadId: string;
  currentTitle: string | null;
  workspaceName: string | null;
  onRenamed: (newTitle: string) => void;
  onDeleted: () => void;
};

type Ctx = {
  open: (args: OpenArgs) => void;
};

const ThreadActionsSheetContext = createContext<Ctx | null>(null);

export function ThreadActionsSheetHost({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<OpenArgs | null>(null);

  const open = useCallback<Ctx["open"]>((args) => {
    setSession(args);
  }, []);

  const ctx = useMemo<Ctx>(() => ({ open }), [open]);

  return (
    <ThreadActionsSheetContext.Provider value={ctx}>
      {children}
      {session ? (
        <ThreadActionsSheet
          visible
          threadId={session.threadId}
          currentTitle={session.currentTitle}
          workspaceName={session.workspaceName}
          onRenamed={session.onRenamed}
          onDeleted={session.onDeleted}
          onClose={() => setSession(null)}
        />
      ) : null}
    </ThreadActionsSheetContext.Provider>
  );
}

export function useThreadActionsSheet(): Ctx {
  const v = useContext(ThreadActionsSheetContext);
  if (!v) {
    throw new Error("useThreadActionsSheet requires <ThreadActionsSheetHost>");
  }
  return v;
}
