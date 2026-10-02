import { nav } from "./nav";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  ${nav("index")}
  <h1>steambun multi-page</h1>
  <p>
    Three pages share <code>nav.ts</code> (its own hashed chunk, via
    <code>build.splitting</code>) and <code>shared.css</code>.
  </p>
`;
