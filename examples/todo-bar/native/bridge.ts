// todo-bar's own native ops. A tab has none of them, so the page checks
// native.has and falls back.
import { defineBridge, op, t } from "steambun/schema";

const Settings = t.struct("TodoSettings", {
  /** The count of open to-dos next to the menu bar icon. */
  showCount: t.bool,
  /** Completed to-dos stay in the list, at the bottom. */
  showCompleted: t.bool,
  /** A tap on the trackpad when you check one off. */
  haptics: t.bool,
  /** Minutes until a new reminder. */
  remindIn: t.int,
  /** Minutes a "Snooze" waits. */
  snooze: t.int,
});

export default defineBridge({
  ops: {
    /** A tap on the trackpad. Felt only on a Force Touch trackpad. */
    "haptic.tap": op(t.none, t.none),
    /** The share menu (Messages, Mail, Notes…) under a rect in the page. */
    "share.text": op(
      t.struct("ShareTextArgs", {
        text: t.string,
        x: t.number,
        y: t.number,
        width: t.number,
        height: t.number,
      }),
      t.none,
    ),
    /** True if Apple Intelligence's on-device model is ready (macOS 26+). */
    "ai.available": op(t.none, t.bool),
    /** Break a to-do into 2–6 steps with the on-device model. */
    "ai.steps": op(
      t.struct("AiStepsArgs", { text: t.string }),
      t.list(t.string),
      {
        async: true,
      },
    ),
    /**
     * A notification in `minutes`, with Done and Snooze buttons. Asks for
     * permission the first time. False if the user said no.
     */
    "remind.set": op(
      t.struct("RemindSetArgs", {
        id: t.string,
        text: t.string,
        minutes: t.number,
        snooze: t.int,
      }),
      t.bool,
      { async: true },
    ),
    "remind.cancel": op(t.struct("RemindCancelArgs", { id: t.string }), t.none),
    /** The Settings window, filled in with these values. */
    "settings.open": op(Settings, t.none),
  },
  events: {
    /** "Done" on a reminder's notification. */
    "remind.done": t.struct("RemindDone", { id: t.string }),
    /** A reminder went off; it no longer waits. */
    "remind.fired": t.struct("RemindFired", { id: t.string }),
    /** A change in the Settings window. */
    "settings.changed": Settings,
  },
});
