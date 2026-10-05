/**
 * Presents a port whose implementation is loaded on first use. Used so demo adapters (and their
 * fixture data) sit behind a dynamic import that is only reachable when the build-time demo flag
 * is on: a production build with NEXT_PUBLIC_CORVIS_DEMO_MODE unset never emits those chunks.
 *
 * Ports are method bags returning promises, so deferring each call behind the loaded instance is
 * transparent to callers. The instance is created once, so stateful demo ports keep their state.
 */
export function lazyPort<T extends object>(load: () => Promise<T>): T {
  let loaded: Promise<T> | undefined;
  const instance = () => (loaded ??= load());
  return new Proxy({} as T, {
    get(_target, property) {
      // Never look like a thenable: `await port` must resolve to the proxy itself.
      if (property === "then") return undefined;
      return (...args: unknown[]) => instance().then((port) => (port as Record<string | symbol, (...values: unknown[]) => unknown>)[property]!(...args));
    },
  });
}
