import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => el.offsetParent !== null);
}

/**
 * Standard modal-dialog focus behaviour: focus moves inside the dialog on
 * mount, Tab/Shift+Tab cycle only among the dialog's own focusable elements,
 * Escape triggers `onClose`, and focus returns to whatever was focused
 * before the dialog opened once it unmounts.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = focusableElements(container);
    (focusables[0] ?? container).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const current = focusableElements(container);
      if (current.length === 0) {
        event.preventDefault();
        return;
      }
      const first = current[0]!;
      const last = current[current.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [containerRef]);
}
