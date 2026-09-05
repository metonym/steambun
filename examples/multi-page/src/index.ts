import { nav } from "./nav";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  ${nav("index")}
  <h1>steambun multi-page</h1>
  <p>
    Three pages share <code>nav.ts</code> (a hashed chunk, keyed by
    <code>build.importMap</code>) and <code>shared.css</code> (cut into its
    own file by <code>build.sharedCss</code>). Edit either one and rebuild —
    only that one file gets a new hash, not every page's.
  </p>
`;
