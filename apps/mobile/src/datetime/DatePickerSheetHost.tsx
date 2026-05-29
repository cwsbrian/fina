import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DatePickerSheet } from "./DatePickerSheet";

/** Same pattern as DateRangeSheetHost — lifts the single-date sheet up
 *  to the root layout so its backdrop dims the entire screen and it
 *  isn't clipped by any embedding scroll container. Any screen calls
 *  `useDatePickerSheet().open(...)`. */

type Ctx = {
  open: (
    value: Date,
    onConfirm: (next: Date) => void,
    opts?: { mode?: "date" | "datetime" | "time"; maximumDate?: Date; minimumDate?: Date },
  ) => void;
};

const DatePickerSheetContext = createContext<Ctx | null>(null);

type Session = {
  value: Date;
  onConfirm: (next: Date) => void;
  mode?: "date" | "datetime" | "time";
  maximumDate?: Date;
  minimumDate?: Date;
};

export function DatePickerSheetHost({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  const open = useCallback<Ctx["open"]>((value, onConfirm, opts) => {
    setSession({ value, onConfirm, ...opts });
  }, []);

  const ctx = useMemo<Ctx>(() => ({ open }), [open]);

  return (
    <DatePickerSheetContext.Provider value={ctx}>
      {children}
      <DatePickerSheet
        visible={session !== null}
        value={session?.value ?? new Date()}
        {...(session?.mode ? { mode: session.mode } : {})}
        {...(session?.maximumDate ? { maximumDate: session.maximumDate } : {})}
        {...(session?.minimumDate ? { minimumDate: session.minimumDate } : {})}
        onClose={() => setSession(null)}
        onConfirm={(next) => {
          session?.onConfirm(next);
          setSession(null);
        }}
      />
    </DatePickerSheetContext.Provider>
  );
}

export function useDatePickerSheet(): Ctx {
  const v = useContext(DatePickerSheetContext);
  if (!v) {
    throw new Error("useDatePickerSheet requires <DatePickerSheetHost>");
  }
  return v;
}
