import { exampleName } from "./shared.ts";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <nav><a href="/">index</a> · <a href="/about">about</a></nav>
  <h1>about</h1>
  <p>Same <code>shared.ts</code> as index (${exampleName}).</p>
`;
