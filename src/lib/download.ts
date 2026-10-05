/**
 * Saves `text` as a file download. The anchor is attached to the document for the click (Firefox ignores
 * clicks on detached anchors) and the object URL is revoked on a later tick: revoking synchronously after
 * `click()` can cancel the download in Safari/Firefox before the browser has started reading the blob.
 */
export function downloadText(name: string, text: string, type: string): void {
  const href = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
}
