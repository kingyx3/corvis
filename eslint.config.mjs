import { readdirSync } from "node:fs";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import layerBoundaries from "./tools/eslint/layer-boundaries.mjs";

// Layer boundaries from docs/architecture/MODULARITY.md and src/modules/README.md, enforced while editing and in
// `npm run lint` (the same rules the control loop scans for as CL-ARCH-001/002, plus the ones below). Paths are
// resolved by tools/eslint/layer-boundaries.mjs, so relative imports and the `@/` alias are both covered.
//
//   domain/        pure contracts: no adapters, server, UI, application, platform or composition
//   ui/            React views and client state: no server, adapters or platform (and no Node-only packages)
//   application/   client-side use cases: no server, adapters or platform
//   server/, adapters/   never import UI or composition (composition wires ports to adapters, not the other way round)
//   adapters/, application/   only the owning module and src/composition wire them in
//   src/platform   infrastructure below the modules: module domain types only, never their server, adapters, ui or application layers
//   src/shared/domain, src/shared/lib   the shared kernel: module domain types only (no runtime layers, platform or composition)
//   production code never imports src/test-support
//
// Tests are exempt (they exercise several layers at once); production code must not depend on test helpers.
const modules = readdirSync("src/modules", { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
const layerGlobs = (layer) => ["src/modules/*/" + layer + "/"];

const layeringZones = [
  {
    target: ["src/modules/*/domain/", "src/shared/domain/"],
    from: [...layerGlobs("adapters"), ...layerGlobs("application"), ...layerGlobs("server"), ...layerGlobs("ui"), "src/platform/", "src/composition/"],
    message: "Domain contracts must not import adapters, application, server, UI, platform or composition code.",
  },
  {
    target: ["src/modules/*/ui/", "src/modules/*/application/", "src/shared/ui/"],
    from: [...layerGlobs("server"), ...layerGlobs("adapters"), "src/platform/"],
    message: "UI and client-side application code depends on domain ports and src/composition, never on server, adapter or platform code.",
  },
  {
    target: [...layerGlobs("server"), ...layerGlobs("adapters")],
    from: [...layerGlobs("ui"), "src/shared/ui/", "src/composition/"],
    message: "Server and adapter code must not import UI or composition code.",
  },
  {
    target: ["src/platform/"],
    from: [...layerGlobs("adapters"), ...layerGlobs("application"), ...layerGlobs("server"), ...layerGlobs("ui")],
    message: "src/platform is infrastructure below the modules: it may use module domain types but not module runtime layers.",
  },
  {
    target: ["src/shared/domain/", "src/shared/lib/"],
    from: [...layerGlobs("adapters"), ...layerGlobs("application"), ...layerGlobs("server"), ...layerGlobs("ui"), "src/platform/", "src/composition/"],
    message: "The shared kernel (src/shared/domain, src/shared/lib) may use module domain types but not module runtime layers, platform or composition.",
  },
  {
    target: ["src/app/", "src/platform/", "src/shared/", ...modules.map((name) => `src/modules/${name}/`)],
    from: ["src/test-support/"],
    message: "Production code must not import test support.",
  },
  // A module's adapters and application layers are wired in by src/composition and the module itself.
  ...modules.map((owner) => ({
    target: ["src/app/", "src/platform/", "src/shared/", ...modules.filter((name) => name !== owner).map((name) => `src/modules/${name}/`)],
    from: [`src/modules/${owner}/adapters/`, `src/modules/${owner}/application/`],
    message: `src/modules/${owner}/adapters and /application are internal: only the module itself and src/composition may import them.`,
  })),
];

// Browser-reachable layers must not pull in Node-only or server-only packages.
const serverOnlyImports = [
  { name: "pg", message: "Database drivers are server-only." },
  { name: "next/server", message: "next/server is server-only." },
  { name: "next/headers", message: "next/headers is server-only." },
  { group: ["node:*"], message: "Node built-ins are server-only." },
];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-plugin-react@7.37.x auto-detects the React version through
    // context.getFilename(), which ESLint 10 removed. Pinning the version
    // skips detection. Keep it in step with the react dependency in package.json.
    settings: { react: { version: "19.3" } },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    plugins: { corvis: layerBoundaries },
    rules: {
      "corvis/layer-boundaries": ["error", { zones: layeringZones }],
    },
  },
  {
    files: ["src/modules/*/ui/**/*.{ts,tsx}", "src/modules/*/application/**/*.{ts,tsx}", "src/modules/*/domain/**/*.{ts,tsx}", "src/shared/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { paths: serverOnlyImports.filter((entry) => entry.name), patterns: serverOnlyImports.filter((entry) => entry.group) }],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", ".claude/**", "tools/convex-conformance/**"]),
]);
