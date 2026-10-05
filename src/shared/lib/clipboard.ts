/**
 * Copies text without ever throwing. `navigator.clipboard` is undefined on insecure origins and
 * `writeText` can throw synchronously (not just reject), so both are wrapped. Resolves to whether
 * the copy succeeded so callers can offer a manual-copy fallback.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
