import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
let counter = 0;

/**
 * Loads JSX code (the hook, the components, an app's actions) that Node cannot import, by bundling it with
 * esbuild, the bundler the apps use, into a temporary module beside the tests. The packages stay external, so
 * React and the SDKs are the ones the test itself loads. Only the sign-in is replaced: appkit's
 * `connectOpenKeyTinyCloud` calls `globalThis.__connectOpenKeyTinyCloud`, which a test sets to hand the hook a
 * signed-in session. Everything else (the hook, `runWithSession`, `putRecord`, the restore) is the real code.
 * Resolves `{ module, cleanup }`; call `cleanup()` when done.
 */
export async function bundle(entrySource, resolveDir) {
  const result = await build({
    stdin: { contents: entrySource, resolveDir, loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react/*", "react-dom", "react-dom/*", "lucide-react", "@openkey/sdk", "@tinycloud/*"],
    plugins: [
      {
        name: "fake-sign-in",
        setup(buildApi) {
          buildApi.onLoad({ filter: /packages[\\/]appkit[\\/]src[\\/]tinycloud\.js$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            const marker = "export async function connectOpenKeyTinyCloud(";
            if (!source.includes(marker)) throw new Error("connectOpenKeyTinyCloud moved: update support/bundle.mjs");
            return {
              contents: `${source.replace(marker, "async function realConnectOpenKeyTinyCloud(")}\nexport const connectOpenKeyTinyCloud = (...args) => globalThis.__connectOpenKeyTinyCloud(...args);\n`,
              loader: "js",
              resolveDir: dirname(args.path),
            };
          });
        },
      },
    ],
  });
  const file = join(here, `..`, `.bundle.${process.pid}.${counter++}.mjs`);
  writeFileSync(file, result.outputFiles[0].text);
  const module = await import(pathToFileURL(file).href);
  return { module, cleanup: () => rmSync(file, { force: true }) };
}
