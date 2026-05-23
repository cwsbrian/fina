import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DateRangeSheet, type DateRange } from "./DateRangeSheet";

/** Lifts the date-range sheet up to the root layout so its backdrop
 *  can dim the bottom tab bar + header + status bar in one go. Any
 *  screen calls `useDateRangeSheet().open(...)` to present it. */

type Ctx = {
  open: (value: DateRange, onConfirm: (next: DateRange) => void) => void;
};

const DateRangeSheetContext = createContext<Ctx | null>(null);

type Session = {
  value: DateRange;
  onConfirm: (next: DateRange) => void;
};

export function DateRangeSheetHost({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  const open = useCallback<Ctx["open"]>((value, onConfirm) => {
    setSession({ value, onConfirm });
  }, []);

  const ctx = useMemo<Ctx>(() => ({ open }), [open]);

  return (
    <DateRangeSheetContext.Provider value={ctx}>
      {children}
      <DateRangeSheet
        visible={session !== null}
        value={session?.value ?? {}}
        onClose={() => setSession(null)}
        onConfirm={(next) => {
          session?.onConfirm(next);
          setSession(null);
        }}
      />
    </DateRangeSheetContext.Provider>
  );
}

export function useDateRangeSheet(): Ctx {
  const v = useContext(DateRangeSheetContext);
  if (!v) {
    throw new Error("useDateRangeSheet requires <DateRangeSheetHost>");
  }
  return v;
}
