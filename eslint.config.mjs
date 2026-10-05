import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-plugin-react@7.37.x auto-detects the React version through
    // context.getFilename(), which ESLint 10 removed. Pinning the version
    // skips detection. Keep it in step with the react dependency in package.json.
    settings: { react: { version: "19.3" } },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", ".claude/**", "db/convex-conformance/**"]),
]);
