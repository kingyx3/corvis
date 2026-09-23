"use client";

import { useRef, type ReactNode } from "react";
import { useFocusTrap } from "@/components/ui/use-focus-trap";

export function Modal({
  label,
  onClose,
  children,
  width = "min(620px, calc(100vw - 32px))",
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
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    style={{
      position: "fixed",
      inset: 0,
      zIndex: 100,
      background: "rgba(15,23,42,.48)",
      display: "flex",
      justifyContent: "center",
      alignItems: align === "top" ? "flex-start" : "center",
      padding: align === "top" ? "10vh 16px 16px" : 20,
    }}
  >
    <section
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      style={{
        width,
        maxHeight: "80vh",
        overflow: "auto",
        background: "#fff",
        borderRadius: 14,
        boxShadow: "0 24px 80px rgba(15,23,42,.24)",
      }}
    >
      {children}
    </section>
  </div>;
}
