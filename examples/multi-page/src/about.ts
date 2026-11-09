import "./shared.css";
import { nav } from "./nav";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  ${nav("about")}
  <h1>about</h1>
  <p>Same shared nav chunk and stylesheet as the other two pages.</p>
`;
