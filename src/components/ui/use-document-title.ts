import { useEffect } from "react";

/**
 * Keeps `document.title` at `title` for a client-driven view. Next.js renders the metadata title as
 * a managed <title> that can be (re)applied after hydration as metadata streams in, which would
 * overwrite a one-shot assignment, so the title is re-asserted whenever the head changes.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const apply = () => { if (document.title !== title) document.title = title; };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [title]);
}
