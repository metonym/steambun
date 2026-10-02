/** Worker count for CPU-heavy async work; the codecs run on Bun's thread pool, so more only queues. */
export const CPU_CONCURRENCY = Math.max(2, navigator.hardwareConcurrency || 4);

/** `Promise.all(items.map(fn))` with at most `limit` in flight; results keep `items` order. */
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
