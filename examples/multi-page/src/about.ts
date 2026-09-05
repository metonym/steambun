// This page links its own about.css and pulls in shared.css via a JS
// import instead — the shared block ends up last in this page's CSS
// output, so build.sharedCss cuts it from the end rather than the start
// (see src/index.ts for the other order).
import "./shared.css";
import { nav } from "./nav";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  ${nav("about")}
  <h1>about</h1>
  <p>Same shared nav chunk and stylesheet as the other two pages.</p>
`;
