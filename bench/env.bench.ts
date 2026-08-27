import { bench, do_not_optimize, group } from "mitata";
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
  bench("parseEnvFile (20 vars)", () => {
    do_not_optimize(parseEnvFile(ENV_FILE_CONTENTS));
  });

  bench("filterPublicEnv (20 vars, 2 prefixes)", () => {
    do_not_optimize(filterPublicEnv(PUBLIC_ENV, ["VITE_", "PUBLIC_"]));
  });

  bench("buildImportMetaEnvDefine (20 vars)", () => {
    do_not_optimize(
      buildImportMetaEnvDefine(PUBLIC_ENV, {
        mode: "development",
        command: "dev",
        base: "/",
      }),
    );
  });
});
