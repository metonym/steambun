// A menu bar to-do list with no core. The page is the whole app, so it
// loads at launch and keeps the menu bar title in step with the list.
import { native } from "steambun/ui";

type Todo = { text: string; done: boolean };
const todos: Todo[] = JSON.parse(localStorage.getItem("todos") ?? "[]");
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const input = $<HTMLInputElement>("text");
const row = $<HTMLTemplateElement>("row").content.firstElementChild!;

function save() {
  localStorage.setItem("todos", JSON.stringify(todos));
  render();
}

function render() {
  $("list").replaceChildren(
    ...todos.map((t, i) => {
      const li = row.cloneNode(true) as HTMLLIElement;
      const box = li.querySelector("input")!;
      box.checked = t.done;
      box.onchange = () => ((t.done = box.checked), save());
      li.querySelector("span")!.textContent = t.text;
      li.querySelector("button")!.onclick = () => (todos.splice(i, 1), save());
      return li;
    }),
  );
  // The count of open to-dos sits next to the icon. None shows just the icon.
  const open = todos.filter((t) => !t.done).length;
  native.send("menuBar.set", { title: open ? String(open) : "" });
}

$("add").onsubmit = (e) => {
  e.preventDefault();
  if (!input.value.trim()) return;
  todos.push({ text: input.value.trim(), done: false });
  input.value = "";
  save();
};

// Escape closes the panel, as it would a menu. Each open focuses the field.
onkeydown = (e) => {
  if (e.key === "Escape") native.send("menuBar.close");
};
native.on("menuBar.open", (e) => e.open && input.focus());

render();
