export interface MarkdownLine {
  number: number;
  text: string;
}

export function isDocumentationPath(path: string): boolean {
  if (!path.toLowerCase().endsWith(".md")) return false;
  return path.startsWith("docs/") || !path.includes("/");
}

export function proseLines(text: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let fenced = false;
  text.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    lines.push({ number: index + 1, text: line });
  });
  return lines;
}

const INLINE_LINK = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const REFERENCE_LINK = /^\s*\[[^\]\n]+\]:\s*(\S+)/;

export interface MarkdownLink {
  target: string;
  line: number;
}

export function markdownLinks(text: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  for (const line of proseLines(text)) {
    const withoutCode = line.text.replace(/`[^`]*`/g, "");
    for (const match of withoutCode.matchAll(INLINE_LINK)) {
      const target = match[1];
      if (target) links.push({ target, line: line.number });
    }
    const reference = REFERENCE_LINK.exec(withoutCode);
    if (reference?.[1]) links.push({ target: reference[1], line: line.number });
  }
  return links;
}

export function resolveRelative(fromPath: string, target: string): string | null {
  const base = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const segments = base ? base.split("/") : [];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

export function relativePathBetween(fromPath: string, targetPath: string): string {
  const fromSegments = fromPath.split("/").slice(0, -1);
  const targetSegments = targetPath.split("/");
  let shared = 0;
  while (shared < fromSegments.length && shared < targetSegments.length - 1 && fromSegments[shared] === targetSegments[shared]) shared += 1;
  const up = fromSegments.slice(shared).map(() => "..");
  const down = targetSegments.slice(shared);
  const joined = [...up, ...down].join("/");
  return up.length === 0 ? `./${joined}` : joined;
}
