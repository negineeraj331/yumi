import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type ToastKind = "info" | "success" | "error";
interface Toast { id: number; kind: ToastKind; message: string }

const Ctx = createContext<{ notify: (message: string, kind?: ToastKind) => void }>({ notify: () => {} });
export const useToast = () => useContext(Ctx);

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((message: string, kind: ToastKind = "info") => {
    const id = ++seq;
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  return (
    <Ctx.Provider value={{ notify }}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.message}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
