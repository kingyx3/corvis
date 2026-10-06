export function matchesPrefix(file: string, prefix: string): boolean;
export function resolveImport(importerPath: string, specifier: string): string | null;
declare const plugin: { rules: Record<string, unknown> };
export default plugin;
