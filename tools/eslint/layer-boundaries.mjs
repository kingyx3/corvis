// ESLint rule `corvis/layer-boundaries`: a file under one of a zone's `target` prefixes must not import (statically,
// dynamically or through a re-export) anything that resolves under one of its `from` prefixes.
//
// Prefixes are repository-relative paths where `*` stands for exactly one path segment, for example
// `src/modules/*/domain/`. Specifiers are resolved the way the build does: `@/x` is `src/x` and relative paths are
// resolved against the importing file. Package imports are not this rule's concern (see `no-restricted-imports`).
// The same notation is used by the control loop's architecture-drift scan (services/control-loop/scanners).
import path from "node:path";

const patternCache = new Map();

/** True when `file` is `prefix` itself or lies below it. */
export function matchesPrefix(file, prefix) {
  let pattern = patternCache.get(prefix);
  if (!pattern) {
    const source = prefix.replace(/\/+$/, "").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+");
    pattern = new RegExp(`^${source}(?:/|$)`);
    patternCache.set(prefix, pattern);
  }
  return pattern.test(file);
}

/** Repository-relative POSIX path an import specifier points at, or null for packages and other specifiers. */
export function resolveImport(importerPath, specifier) {
  if (specifier.startsWith("@/")) return path.posix.normalize(`src/${specifier.slice(2)}`);
  if (specifier.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), specifier));
  return null;
}

const rule = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        additionalProperties: false,
        required: ["zones"],
        properties: {
          zones: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["target", "from", "message"],
              properties: {
                target: { type: "array", items: { type: "string" }, minItems: 1 },
                from: { type: "array", items: { type: "string" }, minItems: 1 },
                message: { type: "string" },
              },
            },
          },
        },
      },
    ],
    messages: { forbidden: "{{message}} (imports {{resolved}})" },
  },
  create(context) {
    const { zones } = context.options[0];
    const relative = path.relative(context.cwd, context.filename).split(path.sep).join("/");
    const active = zones.filter((zone) => zone.target.some((prefix) => matchesPrefix(relative, prefix)));
    if (active.length === 0) return {};

    function check(node, specifier) {
      if (typeof specifier !== "string") return;
      const resolved = resolveImport(relative, specifier);
      if (!resolved) return;
      for (const zone of active) {
        if (zone.from.some((prefix) => matchesPrefix(resolved, prefix))) {
          context.report({ node, messageId: "forbidden", data: { message: zone.message, resolved } });
          return;
        }
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node.source, node.source.value),
      ExportAllDeclaration: (node) => check(node.source, node.source.value),
      ImportExpression: (node) => node.source.type === "Literal" && check(node.source, node.source.value),
      CallExpression: (node) => {
        if (node.callee.type === "Identifier" && node.callee.name === "require" && node.arguments[0]?.type === "Literal") check(node, node.arguments[0].value);
      },
    };
  },
};

const plugin = { rules: { "layer-boundaries": rule } };

export default plugin;
