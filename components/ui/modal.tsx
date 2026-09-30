"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFocusTrap } from "@/components/ui/use-focus-trap";

/** Current values of every control inside a <form> in `container`, used to detect typed input. */
function formValues(container: HTMLElement): string {
  const controls = container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("form input, form textarea, form select");
  return JSON.stringify(Array.from(controls, (control) => {
    if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) return control.checked;
    if (control instanceof HTMLInputElement && (control.type === "button" || control.type === "submit" || control.type === "reset" || control.type === "hidden")) return null;
    return control.value;
  }));
}

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
  const initialValues = useRef<string | null>(null);
  const keepEditingRef = useRef<HTMLButtonElement | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    if (ref.current) initialValues.current = formValues(ref.current);
  }, []);
  useEffect(() => { if (confirmDiscard) keepEditingRef.current?.focus(); }, [confirmDiscard]);

  // A stray click outside or a reflexive Escape must not throw away what was typed into a form.
  // Dialogs without a form (palette, evidence viewer, confirmations) still close immediately; the
  // dialog's own Cancel button remains the explicit way to leave. Escape while the prompt is shown
  // dismisses the prompt and keeps editing.
  const requestClose = () => {
    const dirty = ref.current != null && initialValues.current != null && formValues(ref.current) !== initialValues.current;
    if (dirty) setConfirmDiscard(true); else onClose();
  };
  // Dismissing the prompt unmounts the focused "Keep editing" button; keep focus inside the dialog.
  const keepEditing = () => { setConfirmDiscard(false); ref.current?.focus(); };
  useFocusTrap(ref, () => { if (confirmDiscard) keepEditing(); else requestClose(); });

  return <div
    role="presentation"
    className={`dialog-backdrop${align === "top" ? " align-top" : ""}`}
    onMouseDown={(event) => {
      if (event.target !== event.currentTarget) return;
      // The default action of a mousedown on a non-focusable backdrop is to blur the focused control to
      // <body>, which would undo the focus the discard prompt just took and leave Escape/Tab outside the trap.
      event.preventDefault();
      requestClose();
    }}
  >
    <section ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className="dialog-surface" style={{ width }}>
      {children}
      {confirmDiscard && <div className="lineage-note tone-warning modal-discard-confirm" role="alert">
        <div><strong>Discard what you entered?</strong><span>Closing this dialog will lose the changes you typed.</span></div>
        <button type="button" className="secondary-button" ref={keepEditingRef} onClick={keepEditing}>Keep editing</button>
        <button type="button" className="danger-button" onClick={onClose}>Discard and close</button>
      </div>}
    </section>
  </div>;
}
