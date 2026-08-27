import { exampleName } from "./shared.ts";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <nav><a href="/">index</a> · <a href="/about">about</a></nav>
  <h1>steambun</h1>
  <p>${exampleName}. Two HTML entries share <code>shared.ts</code>; that becomes a hashed chunk. Click to <code>import()</code> <code>lazy.ts</code>.</p>
  <button type="button" id="load">Load lazy chunk</button>
  <p id="lazy"></p>
`;

document.querySelector("#load")!.addEventListener("click", async () => {
  const { lazyLabel } = await import("./lazy.ts");
  document.querySelector("#lazy")!.textContent = lazyLabel;
});
