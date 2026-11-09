import { group, task } from "ostia";
import {
  buildImportMetaEnvDefine,
  filterPublicEnv,
  parseEnvFile,
} from "../src/env/loader";

const ENV_FILE_CONTENTS = Array.from(
  { length: 20 },
  (_, i) => `VITE_VAR_${i}="value-${i}"`,
).join("\n");

const PUBLIC_ENV: Record<string, string> = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => [`VITE_VAR_${i}`, `value-${i}`]),
);

group("env/loader: startup path", () => {
  task("parseEnvFile (20 vars)", () => parseEnvFile(ENV_FILE_CONTENTS));

  task("filterPublicEnv (20 vars, 2 prefixes)", () =>
    filterPublicEnv(PUBLIC_ENV, ["VITE_", "PUBLIC_"]),
  );

  task("buildImportMetaEnvDefine (20 vars)", () =>
    buildImportMetaEnvDefine(PUBLIC_ENV, {
      mode: "development",
      command: "dev",
      base: "/",
    }),
  );
});
