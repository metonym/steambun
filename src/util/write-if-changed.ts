/** Writes only when the content differs: a no-op write still bumps mtime and retriggers `tsc --watch`. Returns whether it wrote. */
export async function writeIfChanged(
  path: string,
  content: string,
): Promise<boolean> {
  const file = Bun.file(path);
  if ((await file.exists()) && (await file.text()) === content) return false;
  await Bun.write(path, content);
  return true;
}
