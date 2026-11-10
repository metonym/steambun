// A menu bar to-do list with no core. The page is the whole app, so it
// loads at launch and keeps the menu bar title in step with the list.
//
// Native parts, each with a fallback in a tab (native.has):
//   SF Symbols         the icons (icons.ts)
//   ai.steps           "Break into steps" with Apple Intelligence
//   remind.set         a notification with Mark as Done and Snooze
//   settings.open      a SwiftUI Settings window
//   haptic.tap         a trackpad tap on check-off
//   share.text         the system share menu
import { native } from "steambun/ui";
import { icon } from "./icons.ts";

interface Step {
  text: string;
  done: boolean;
}
interface Todo {
  id: string;
  text: string;
  done: boolean;
  steps?: Step[];
  /** When its reminder goes off (ms since 1970). */
  remindAt?: number;
}
interface Settings {
  showCount: boolean;
  showCompleted: boolean;
  haptics: boolean;
  remindIn: number;
  snooze: number;
}

const DEFAULTS: Settings = {
  showCount: true,
  showCompleted: true,
  haptics: true,
  remindIn: 60,
  snooze: 10,
};

const newId = () => Math.random().toString(36).slice(2, 10);
const todos: Todo[] = (
  JSON.parse(localStorage.getItem("todos") ?? "[]") as Todo[]
).map((t) => ({ ...t, id: t.id ?? newId() }));
let settings: Settings = {
  ...DEFAULTS,
  ...JSON.parse(localStorage.getItem("settings") ?? "{}"),
};
/** To-dos waiting on the model. */
const thinking = new Set<string>();
let aiReady = false;

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const input = $<HTMLInputElement>("text");
const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  ...kids: (Node | string)[]
) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.append(...kids);
  return el;
};

function save() {
  localStorage.setItem("todos", JSON.stringify(todos));
  render();
}

function saveSettings(s: Settings) {
  settings = s;
  localStorage.setItem("settings", JSON.stringify(s));
  render();
}

// MARK: Rendering

/** A round check, like Reminders: a ring that fills with the accent. */
function check(done: boolean, label: string, onToggle: (v: boolean) => void) {
  const b = h("button", "check");
  b.setAttribute("role", "checkbox");
  b.setAttribute("aria-checked", String(done));
  b.setAttribute("aria-label", label);
  b.onclick = () => {
    const v = !done;
    if (v && settings.haptics && native.has("haptic.tap"))
      native.call("haptic.tap");
    onToggle(v);
  };
  return b;
}

function action(name: string, title: string, run: (el: HTMLElement) => void) {
  const b = h("button", "act", icon(name, 13));
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onclick = (e) => {
    e.stopPropagation();
    run(b);
  };
  return b;
}

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function row(t: Todo) {
  const li = h("li", "todo");
  li.dataset.id = t.id;
  li.classList.toggle("done", t.done);
  const title = h("span", "title selectable", t.text);
  const body = h("div", "body", title);
  if (t.remindAt && !t.done) {
    const late = t.remindAt < Date.now();
    body.append(
      h(
        "span",
        `when${late ? " late" : ""}`,
        icon("bell.fill", 9),
        time(t.remindAt),
      ),
    );
  }
  if (thinking.has(t.id)) body.append(h("span", "thinking", "Thinking…"));

  const acts = h("div", "acts");
  if (aiReady && !t.done && !t.steps?.length && !thinking.has(t.id))
    acts.append(action("sparkles", "Break into Steps", () => breakDown(t)));
  if (!t.done)
    acts.append(
      t.remindAt
        ? action("bell.fill", "Cancel Reminder", () => unremind(t))
        : action("bell", `Remind Me in ${mins(settings.remindIn)}`, () =>
            remind(t),
          ),
    );
  acts.append(
    action("square.and.arrow.up", "Share", (el) => share(t, el)),
    action("trash", "Delete", () => remove(t)),
  );

  li.append(
    h(
      "div",
      "line",
      check(t.done, t.text, (v) => {
        t.done = v;
        if (v) unremind(t, false);
        save();
      }),
      body,
      acts,
    ),
  );
  if (t.steps?.length) {
    const ul = h("ul", "steps");
    for (const s of t.steps) {
      const sl = h("li", `step${s.done ? " done" : ""}`);
      sl.append(
        check(s.done, s.text, (v) => {
          s.done = v;
          // The last step done finishes the to-do.
          if (t.steps!.every((x) => x.done)) t.done = true;
          save();
        }),
        h("span", "title selectable", s.text),
      );
      ul.append(sl);
    }
    li.append(ul);
  }
  return li;
}

function render() {
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);
  const shown = settings.showCompleted ? [...open, ...done] : open;
  $("list").replaceChildren(...shown.map(row));
  $("count").textContent = String(open.length);
  $("empty").hidden = shown.length > 0;
  $("empty-title").textContent = todos.length > 0 ? "All Done" : "No To-Dos";
  $("foot").hidden = done.length === 0;
  $("done-count").textContent = `${done.length} Completed`;
  $("toggle-done").textContent = settings.showCompleted ? "Hide" : "Show";
  // The count of open to-dos sits next to the icon. None shows just the icon.
  native.send("menuBar.set", {
    title: settings.showCount && open.length > 0 ? String(open.length) : "",
  });
}

// MARK: Actions

function remove(t: Todo) {
  unremind(t, false);
  todos.splice(todos.indexOf(t), 1);
  save();
}

/** The Mac share menu, or the browser's. A browser without one copies. */
async function share(t: Todo, el: HTMLElement) {
  const text = [t.text, ...(t.steps ?? []).map((s) => `• ${s.text}`)].join(
    "\n",
  );
  if (native.has("share.text")) {
    const { x, y, width, height } = el.getBoundingClientRect();
    return native.call("share.text", { text, x, y, width, height });
  }
  if (navigator.share) return navigator.share({ text }).catch(() => {});
  await navigator.clipboard.writeText(text);
  el.title = "Copied";
}

/** Apple Intelligence splits it into steps. Only offered where it runs. */
async function breakDown(t: Todo) {
  thinking.add(t.id);
  render();
  try {
    const steps = await native.call("ai.steps", { text: t.text });
    t.steps = steps.map((text) => ({ text, done: false }));
  } catch (e) {
    console.warn("ai.steps", e);
  } finally {
    thinking.delete(t.id);
    save();
  }
}

function mins(m: number) {
  if (m < 60) return `${m} min`;
  return m === 60 ? "1 hour" : `${m / 60} hours`;
}

/** A notification in the Mac app; a timer and the Notification API in a tab. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
async function remind(t: Todo) {
  const minutes = settings.remindIn;
  let ok: boolean;
  if (native.has("remind.set")) {
    ok = await native.call("remind.set", {
      id: t.id,
      text: t.text,
      minutes,
      snooze: settings.snooze,
    });
  } else {
    ok =
      "Notification" in window &&
      (await Notification.requestPermission()) === "granted";
    if (ok)
      timers.set(
        t.id,
        setTimeout(() => {
          new Notification(t.text, { body: "Reminder from TodoBar" });
          fired(t.id);
        }, minutes * 60_000),
      );
  }
  if (!ok)
    return flash("Turn on notifications for TodoBar in System Settings.");
  t.remindAt = Date.now() + minutes * 60_000;
  save();
}

function unremind(t: Todo, write = true) {
  if (!t.remindAt) return;
  if (native.has("remind.cancel")) native.call("remind.cancel", { id: t.id });
  clearTimeout(timers.get(t.id));
  delete t.remindAt;
  if (write) save();
}

function fired(id: string) {
  const t = todos.find((x) => x.id === id);
  if (t) render();
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;
function flash(msg: string) {
  const el = $("flash");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.hidden = true), 3500);
}

// MARK: Settings

/** The SwiftUI window in the Mac app; the same fields in a dialog in a tab. */
function openSettings() {
  if (native.has("settings.open"))
    return native.send("settings.open", settings);
  const d = $<HTMLDialogElement>("settings");
  const f = d.querySelector("form")!;
  for (const [k, v] of Object.entries(settings)) {
    const el = f.elements.namedItem(k) as HTMLInputElement | HTMLSelectElement;
    if (el instanceof HTMLInputElement) el.checked = v as boolean;
    else el.value = String(v);
  }
  f.onchange = () => {
    const get = (k: string) => f.elements.namedItem(k) as HTMLInputElement;
    saveSettings({
      showCount: get("showCount").checked,
      showCompleted: get("showCompleted").checked,
      haptics: get("haptics").checked,
      remindIn: Number(get("remindIn").value),
      snooze: Number(get("snooze").value),
    });
  };
  d.showModal();
}

// MARK: Wiring

$("add").onsubmit = (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  todos.unshift({ id: newId(), text, done: false });
  input.value = "";
  save();
};
$("add-icon").replaceWith(icon("plus.circle.fill", 18, "medium"));
$("gear").append(icon("gearshape", 14));
$("gear").onclick = openSettings;
$("empty-icon").replaceWith(icon("checkmark.circle", 40, "regular"));
$("toggle-done").onclick = () =>
  saveSettings({ ...settings, showCompleted: !settings.showCompleted });
$("clear-done").onclick = () => {
  for (const t of todos.filter((x) => x.done)) remove(t);
};

native.on("settings.changed", saveSettings);
native.on("remind.done", ({ id }) => {
  const t = todos.find((x) => x.id === id);
  if (!t) return;
  t.done = true;
  delete t.remindAt;
  save();
});
native.on("remind.fired", ({ id }) => fired(id));

// Escape closes the panel, as it would a menu. Each open focuses the field.
onkeydown = (e) => {
  if (e.key === "Escape" && !document.querySelector("dialog[open]"))
    native.send("menuBar.close");
};
native.on("menuBar.open", (e) => e.open && (input.focus(), render()));

if (native.has("ai.available"))
  native.call("ai.available").then((ok) => {
    aiReady = ok;
    render();
  });
render();
