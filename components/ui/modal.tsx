"use client";

import { useRef, type ReactNode } from "react";
import { useFocusTrap } from "@/components/ui/use-focus-trap";

export function Modal({
  label,
  onClose,
  children,
  width = "min(620px, 100%)",
  align = "center",
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  align?: "center" | "top";
}) {
  const ref = useRef<HTMLElement | null>(null);
  useFocusTrap(ref, onClose);

  return <div
    role="presentation"
    className={`dialog-backdrop${align === "top" ? " align-top" : ""}`}
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
  >
    <section ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className="dialog-surface" style={{ width }}>
      {children}
    </section>
  </div>;
}
