/**
 * Sequences overlapping async loads: only the most recently started one may apply its result, so an
 * older, slower response can never overwrite a newer one. Each gate tracks one kind of request.
 */
export function createLatestRequestGate() {
  let latest = 0;
  return async function run<T>(load: () => Promise<T>, apply: (value: T) => void): Promise<void> {
    const request = ++latest;
    const value = await load();
    if (request === latest) apply(value);
  };
}
