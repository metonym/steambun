// One op of your own, in Swift: sound.play. It's declared in
// native/bridge.ts and written in native/Sources/Sound.swift, so the name,
// the args and the result are typed here.
//
// A browser tab has no Swift, so there the page plays its own "tink" with
// Web Audio. Check `native.has` for any op a tab can't run.
import { native } from "steambun/ui";

let plays = 0;
let audio: AudioContext | undefined;

/** A short, high ping, close to the system's Tink. */
function tink() {
  audio ??= new AudioContext();
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = 2400;
  gain.gain.setValueAtTime(0.2, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + 0.15);
  return true;
}

async function play() {
  const ok = native.has("sound.play")
    ? await native.call("sound.play", { name: "Tink" })
    : tink();
  document.getElementById("played")!.textContent = ok
    ? `played ${++plays}×`
    : "no such sound";
}

document.getElementById("play")!.onclick = play;
native.command("play", play); // View → Play Sound, ⇧⌘P, or the toolbar
native.command("reload-page", () => location.reload()); // the toolbar
