"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type ToastEntry = { id: number; message: string };

const ToastContext = createContext<((message: string) => void) | null>(null);

// One product, one toast: a global bottom-center, stacking notification host
// replacing the separate per-page implementations that used to exist
// (Browse/Organize's useBulkPhotoActions toast, Trash's inline restore
// banner) - per chat1.md's "one global toast would feel far more one
// product" audit note.
export function useToast() {
  const showToast = useContext(ToastContext);
  if (!showToast) throw new Error("useToast must be used within ToastProviderV2");
  return showToast;
}

export function ToastProviderV2({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const idRef = useRef(0);

  const showToast = useCallback((message: string) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div className="ps2-toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className="ps2-toast">
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
