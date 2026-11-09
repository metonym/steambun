// One op of your own, in Swift: sound.play. It's declared in
// native/bridge.ts and written in native/Sources/Sound.swift, so the name,
// the args and the result are typed here.
import { native } from "steambun/ui";

let plays = 0;
async function play() {
  const ok = await native.call("sound.play", { name: "Tink" });
  document.getElementById("played")!.textContent = ok
    ? `played ${++plays}×`
    : "no such sound";
}

document.getElementById("play")!.onclick = play;
native.command("play", play); // View → Play Sound, or ⇧⌘P
