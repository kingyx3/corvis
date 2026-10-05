export function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const fixed = (index: number) => (bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0);
  let index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  let text = fixed(index);
  // Rounding can reach the next unit's threshold (1048575 B -> "1024" KB); carry into that unit instead.
  if (Number(text) >= 1024 && index < units.length - 1) { index += 1; text = fixed(index); }
  return `${text} ${units[index]}`;
}
