import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/build/build";
import {
  cutSpan,
  groupSharedCssInputs,
  reconstructionMatches,
} from "../src/build/shared-css";

function fakeCssMetafile(
  outputs: Record<string, { entryPoint: string; inputs: string[] }>,
): Bun.BuildMetafile {
  const built: Record<string, unknown> = {};
  for (const [path, o] of Object.entries(outputs)) {
    const inputs: Record<string, { bytesInOutput: number }> = {};
    for (const input of o.inputs) inputs[input] = { bytesInOutput: 1 };
    built[path] = {
      bytes: 10,
      entryPoint: o.entryPoint,
      inputs,
      imports: [],
      exports: [],
    };
  }
  return { inputs: {}, outputs: built } as unknown as Bun.BuildMetafile;
}

describe("groupSharedCssInputs", () => {
  test("groups by exact page set: all pages, a pair, and a dropped single page", () => {
    const metafile = fakeCssMetafile({
      "./assets/index.css": {
        entryPoint: "index.html",
        inputs: ["src/vendor.css", "src/ab.css", "src/index.css"],
      },
      "./assets/about.css": {
        entryPoint: "about.html",
        inputs: ["src/vendor.css", "src/ab.css", "src/about.css"],
      },
      "./assets/blog.css": {
        entryPoint: "blog.html",
        inputs: ["src/vendor.css", "src/blog.css"],
      },
    });
    const groups = groupSharedCssInputs(metafile);

    const allPages = groups.find((g) => g.inputs.includes("src/vendor.css"));
    expect(allPages?.pages).toEqual(["about.html", "blog.html", "index.html"]);

    const pair = groups.find((g) => g.inputs.includes("src/ab.css"));
    expect(pair?.pages).toEqual(["about.html", "index.html"]);

    const allInputs = groups.flatMap((g) => g.inputs);
    expect(allInputs).not.toContain("src/index.css");
    expect(allInputs).not.toContain("src/about.css");
    expect(allInputs).not.toContain("src/blog.css");
  });

  test("preserves the alphabetically-first sharing page's input order", () => {
    const metafile = fakeCssMetafile({
      "./assets/about.css": {
        entryPoint: "about.html",
        inputs: ["src/b.css", "src/a.css"],
      },
      "./assets/blog.css": {
        entryPoint: "blog.html",
        inputs: ["src/a.css", "src/b.css"],
      },
    });
    const groups = groupSharedCssInputs(metafile);
    expect(groups[0]?.inputs).toEqual(["src/b.css", "src/a.css"]);
  });
});

describe("cutSpan", () => {
  test("a shared block at the start is 'before'", () => {
    expect(cutSpan(".shared{}.rest{}", ".shared{}")).toEqual({
      rest: ".rest{}",
      position: "before",
    });
  });

  test("a shared block at the end is 'after'", () => {
    expect(cutSpan(".rest{}.shared{}", ".shared{}")).toEqual({
      rest: ".rest{}",
      position: "after",
    });
  });

  test("a shared block in the middle is null", () => {
    expect(cutSpan(".a{}.shared{}.b{}", ".shared{}")).toBeNull();
  });

  test("an absent shared block is null", () => {
    expect(cutSpan(".a{}.b{}", ".shared{}")).toBeNull();
  });

  test("tolerates a trailing newline after the shared block", () => {
    expect(cutSpan(".rest{}.shared{}\n", ".shared{}")).toEqual({
      rest: ".rest{}",
      position: "after",
    });
  });
});

describe("reconstructionMatches (equivalence guard)", () => {
  test("matches when the cuts reassemble the original", () => {
    const original = "body{a:1}.shared{b:2}";
    const cuts = [{ text: ".shared{b:2}", position: "after" as const }];
    expect(reconstructionMatches(cuts, "body{a:1}", original)).toBe(true);
  });

  test("tolerates only the original's own trailing newline", () => {
    const original = "body{a:1}.shared{b:2}\n";
    const cuts = [{ text: ".shared{b:2}", position: "after" as const }];
    expect(reconstructionMatches(cuts, "body{a:1}", original)).toBe(true);
  });

  test("catches a corrupted cut (lost content) instead of restoring it silently", () => {
    const original = "body{a:1}.shared{b:2}";
    // A cut whose text doesn't match what was actually removed from `rest` —
    // simulates a group/page mismatch slipping past cutSpan.
    const corruptCuts = [
      { text: ".shared{b:2}extra{c:3}", position: "after" as const },
    ];
    expect(reconstructionMatches(corruptCuts, "body{a:1}", original)).toBe(
      false,
    );
  });
});

function writeSharedCssFixture(dir: string): void {
  mkdirSync(join(dir, "src"));
  for (const page of ["index", "about", "blog"]) {
    writeFileSync(
      join(dir, `${page}.html`),
      `<!doctype html><html><head><link rel="stylesheet" href="./src/${page}.css"></head><body><script type="module" src="./src/${page}.ts"></script></body></html>\n`,
    );
  }
  writeFileSync(
    join(dir, "src/shared.css"),
    `.shared-a{color:red}\n.shared-b{color:blue}\n.shared-c{color:green}\n`,
  );
  writeFileSync(
    join(dir, "src/index.css"),
    `@import "./shared.css";\nbody { --p: index; }\n`,
  );
  writeFileSync(join(dir, "src/about.css"), `body { --p: about; }\n`);
  writeFileSync(join(dir, "src/blog.css"), `body { --p: blog; }\n`);
  writeFileSync(join(dir, "src/index.ts"), `console.log("index");\n`);
  writeFileSync(
    join(dir, "src/about.ts"),
    `import "./about.css";\nimport "./shared.css";\nconsole.log("about");\n`,
  );
  writeFileSync(
    join(dir, "src/blog.ts"),
    `import "./blog.css";\nimport "./shared.css";\nconsole.log("blog");\n`,
  );
  writeFileSync(
    join(dir, "steambun.config.ts"),
    `export default { build: { sharedCss: { minSize: 10 }, manifest: true, sri: true, server: false } };\n`,
  );
}

function cssHrefs(html: string): string[] {
  return [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map(
    (m) => m[1]!,
  );
}

describe("shared css extraction (integration)", () => {
  test("page CSS files shrink and links land at the right position per page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-sharedcss-"));
    writeSharedCssFixture(dir);
    await build({ root: dir });

    const indexHtml = await Bun.file(join(dir, "dist/index.html")).text();
    const aboutHtml = await Bun.file(join(dir, "dist/about.html")).text();
    const blogHtml = await Bun.file(join(dir, "dist/blog.html")).text();

    // index: shared before its own stylesheet (the @import was first)
    const indexHrefs = cssHrefs(indexHtml);
    expect(indexHrefs[0]).toContain("shared-");
    expect(indexHrefs[1]).toContain("index-");

    // about/blog: shared after their own stylesheet (JS import was last)
    for (const html of [aboutHtml, blogHtml]) {
      const hrefs = cssHrefs(html);
      expect(hrefs[0]).not.toContain("shared-");
      expect(hrefs[1]).toContain("shared-");
    }
  });

  test("concatenating in link order equals the original page CSS byte for byte", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-sharedcss-"));
    writeSharedCssFixture(dir);
    await build({ root: dir });

    const plainDir = mkdtempSync(join(tmpdir(), "steambun-sharedcss-plain-"));
    writeSharedCssFixture(plainDir);
    writeFileSync(
      join(plainDir, "steambun.config.ts"),
      `export default { build: { sharedCss: false, server: false } };\n`,
    );
    await build({ root: plainDir });

    for (const page of ["index", "about", "blog"]) {
      const html = await Bun.file(join(dir, "dist", `${page}.html`)).text();
      let combined = "";
      for (const href of cssHrefs(html)) {
        combined += await Bun.file(
          join(dir, "dist", href.replace(/^\.\//, "")),
        ).text();
      }

      const plainHtml = await Bun.file(
        join(plainDir, "dist", `${page}.html`),
      ).text();
      const plainHref = cssHrefs(plainHtml)[0]!;
      const original = await Bun.file(
        join(plainDir, "dist", plainHref.replace(/^\.\//, "")),
      ).text();

      expect(combined.trimEnd()).toBe(original.trimEnd());
    }
  });

  test("changing the shared stylesheet leaves page CSS filenames unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-sharedcss-"));
    writeSharedCssFixture(dir);
    await build({ root: dir });
    const before = readdirSync(join(dir, "dist/assets")).filter(
      (f) => f.endsWith(".css") && !f.startsWith("shared-"),
    );

    writeFileSync(
      join(dir, "src/shared.css"),
      `.shared-a{color:red}\n.shared-b{color:blue}\n.shared-c{color:green}\n.shared-d{color:orange}\n`,
    );
    await build({ root: dir });
    const after = readdirSync(join(dir, "dist/assets")).filter(
      (f) => f.endsWith(".css") && !f.startsWith("shared-"),
    );

    expect(after.sort()).toEqual(before.sort());
  });

  test("changing one page's stylesheet leaves the shared filename unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-sharedcss-"));
    writeSharedCssFixture(dir);
    await build({ root: dir });
    const sharedBefore = readdirSync(join(dir, "dist/assets")).find((f) =>
      f.startsWith("shared-"),
    );

    writeFileSync(join(dir, "src/about.css"), `body { --p: about-changed; }\n`);
    await build({ root: dir });
    const sharedAfter = readdirSync(join(dir, "dist/assets")).find((f) =>
      f.startsWith("shared-"),
    );

    expect(sharedAfter).toBe(sharedBefore);
  });

  test("manifest.json css arrays include the shared file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-sharedcss-"));
    writeSharedCssFixture(dir);
    await build({ root: dir });

    const manifest = JSON.parse(
      await Bun.file(join(dir, "dist/manifest.json")).text(),
    ) as Record<string, { css?: string[] }>;
    const sharedFile = readdirSync(join(dir, "dist/assets")).find((f) =>
      f.startsWith("shared-"),
    )!;
    const referenced = Object.values(manifest).some((chunk) =>
      chunk.css?.some((c) => c.endsWith(sharedFile)),
    );
    expect(referenced).toBe(true);
  });

  test("minSize above the combined shared size skips extraction entirely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-sharedcss-"));
    writeSharedCssFixture(dir);
    writeFileSync(
      join(dir, "steambun.config.ts"),
      `export default { build: { sharedCss: { minSize: 1000000 }, server: false } };\n`,
    );
    await build({ root: dir });

    const files = readdirSync(join(dir, "dist/assets"));
    expect(files.some((f) => f.startsWith("shared-"))).toBe(false);
    const html = await Bun.file(join(dir, "dist/index.html")).text();
    expect(cssHrefs(html)).toHaveLength(1);
  });

  test("with sri: true, the shared link gets an integrity attribute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-sharedcss-"));
    writeSharedCssFixture(dir);
    await build({ root: dir });

    const html = await Bun.file(join(dir, "dist/index.html")).text();
    const sharedLink = html.match(
      /<link rel="stylesheet"[^>]*href="[^"]*shared-[^"]*"[^>]*>/,
    )?.[0];
    expect(sharedLink).toContain("integrity=");
  });
});
