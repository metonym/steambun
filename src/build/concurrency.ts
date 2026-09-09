/**
 * Bounded-concurrency worker count for CPU-heavy async work (compression,
 * `--compile` targets). The async codecs run on Bun's thread pool, so more
 * workers than cores only adds queueing.
 */
export const CPU_CONCURRENCY = Math.max(2, navigator.hardwareConcurrency || 4);

/**
 * `Promise.all(items.map(fn))` with at most `limit` in flight. Results keep
 * `items`' order, so callers stay deterministic; the first rejection wins,
 * exactly as `Promise.all` would.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}
