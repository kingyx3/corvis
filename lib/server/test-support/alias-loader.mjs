import { pathToFileURL } from "node:url";
import path from "node:path";

/**
 * Resolves the `@/...` path alias that Next.js applies to `app/**` (and other
 * browser/build-time) source, so `node --test` can import a route module
 * directly. tsconfig.json defines this mapping (`"@/*": ["./*"]`); Next's
 * bundler applies it when the app is actually built/served, but plain
 * `node --test` has no bundler and does not otherwise understand it.
 *
 * This is test-only infrastructure. Registered by a specific test module via
 * `node:module`'s `register()`, never globally.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    let relative = specifier.slice(2);
    if (!path.extname(relative)) relative += ".ts";
    const target = pathToFileURL(path.join(process.cwd(), relative)).href;
    return nextResolve(target, context);
  }
  return nextResolve(specifier, context);
}
