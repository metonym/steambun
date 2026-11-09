// The app's own native op. Optional: delete this folder and the app still
// runs, with only the framework's ops.
import { defineBridge, op, t } from "steambun/schema";

export default defineBridge({
  ops: {
    /** Play a system sound by name. False if there's no such sound. */
    "sound.play": op(t.struct("SoundPlayArgs", { name: t.string }), t.bool),
  },
});
