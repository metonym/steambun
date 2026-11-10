// Publish an update feed for an app. `steambun release` runs this.
//
//   steambun release keygen
//   steambun release NEW.app OUT_DIR [OLD.app …]
//
// keygen writes native/.keys/update.key (private, never commit) and
// native/.keys/update.pub (the base64 public key `steambun app` puts in
// the app). Both are under the app's root. UPDATE_KEY_FILE overrides the
// private key's path.
//
// A release writes, into OUT_DIR:
//   blobs/<sha>.zst           every file of NEW.app, zstd
//   patches/<from>-<to>.zst   a patch for each file that changed since an OLD.app
//   latest.json, latest.json.sig
// Blobs and patches are named by content, so old ones stay valid and one
// OUT_DIR can hold every release.
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { done, shown, since, size } from "./term.ts";

const keysIn = (root: string) => join(root, "native/.keys");
const keyFileIn = (root: string) =>
  process.env.UPDATE_KEY_FILE ?? join(keysIn(root), "update.key");

/** Make the update signing key pair. Fails if the private key exists. */
export function keygen(root: string) {
  const KEYS = keysIn(root);
  const keyFile = keyFileIn(root);
  if (existsSync(keyFile))
    throw new Error(`${shown(keyFile)} exists; delete it to make a new key`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(keyFile), { recursive: true });
  // Only the owner can read the key, from the first byte written.
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  // The raw key is the last 32 bytes of the SPKI encoding.
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  Bun.write(join(KEYS, "update.pub"), raw.toString("base64") + "\n");
  done({
    step: "key",
    path: shown(keyFile),
    note: "private: keep it out of git",
  });
  done({
    step: "pub",
    path: shown(join(KEYS, "update.pub")),
    note: "public: the app checks updates with it",
  });
}

function files(app: string): string[] {
  const out: string[] = [];
  for (const rel of readdirSync(app, { recursive: true }) as string[]) {
    const st = lstatSync(join(app, rel));
    if (st.isSymbolicLink())
      throw new Error(`symlinks are not supported: ${rel}`);
    if (st.isFile()) out.push(rel);
  }
  return out.sort();
}

const sha = (b: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(b).digest("hex");

async function zstd(args: string[]) {
  const p = Bun.spawn(["zstd", "-q", "-f", ...args], { stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`zstd ${args.join(" ")} failed`);
}

async function version(app: string): Promise<string> {
  const p = Bun.spawn([
    "plutil",
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    join(app, "Contents/Info.plist"),
  ]);
  return (await new Response(p.stdout).text()).trim();
}

/** Write NEW.app's feed into `out`, with patches from each old app. */
export async function release(
  root: string,
  app: string,
  out: string,
  olds: string[],
) {
  const keyFile = keyFileIn(root);
  const t0 = performance.now();
  const ver = await version(app);
  // Hashes of each old app's files, by path.
  const oldSha = await Promise.all(
    olds.map(async (o) => {
      const m = new Map<string, string>();
      for (const f of files(o))
        m.set(f, sha(await Bun.file(join(o, f)).bytes()));
      return { dir: o, m };
    }),
  );
  const entries = [];
  let blobBytes = 0;
  let patchBytes = 0;
  for (const f of files(app)) {
    const src = join(app, f);
    const bytes = await Bun.file(src).bytes();
    const h = sha(bytes);
    const blob = `blobs/${h}.zst`;
    if (!existsSync(join(out, blob))) {
      mkdirSync(join(out, "blobs"), { recursive: true });
      await zstd(["-19", "-T0", "--long=27", src, "-o", join(out, blob)]);
    }
    blobBytes += statSync(join(out, blob)).size;
    const patches: Record<string, string> = {};
    for (const { dir, m } of oldSha) {
      const from = m.get(f);
      if (!from || from === h || patches[from]) continue;
      const p = `patches/${from}-${h}.zst`;
      if (!existsSync(join(out, p))) {
        mkdirSync(join(out, "patches"), { recursive: true });
        await zstd([
          "-19",
          "--long=27",
          `--patch-from=${join(dir, f)}`,
          src,
          "-o",
          join(out, p),
        ]);
      }
      // Only list a patch that beats the whole file.
      const n = statSync(join(out, p)).size;
      if (n < statSync(join(out, blob)).size) {
        patches[from] = p;
        patchBytes += n;
      }
    }
    entries.push({
      path: f,
      sha256: h,
      size: bytes.length,
      mode: statSync(src).mode & 0o777,
      blob,
      ...(Object.keys(patches).length > 0 ? { patches } : {}),
    });
  }
  const body = Buffer.from(
    JSON.stringify({ version: ver, files: entries }, null, 1),
  );
  const key = createPrivateKey(await Bun.file(keyFile).text());
  await Bun.write(join(out, "latest.json"), body);
  await Bun.write(
    join(out, "latest.json.sig"),
    sign(null, body, key).toString("base64") + "\n",
  );
  done({
    step: "feed",
    path: shown(out),
    note: `${ver} · ${entries.length} files · blobs ${size(blobBytes)} · patches ${size(patchBytes)}`,
    ms: since(t0),
  });
}
