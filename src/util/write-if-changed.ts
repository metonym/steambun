/**
 * Writes `content` to `path` only if it differs from what's already there.
 * `routes.d.ts`/`env.d.ts` and the synthesized dev server are regenerated on
 * every restart; a no-op write still bumps mtime, which is enough to trigger
 * an editor's or `tsc --watch`'s re-check even though nothing changed.
 *
 * @returns whether a write happened.
 */
export async function writeIfChanged(
  path: string,
  content: string,
): Promise<boolean> {
  const file = Bun.file(path);
  if ((await file.exists()) && (await file.text()) === content) return false;
  await Bun.write(path, content);
  return true;
}
