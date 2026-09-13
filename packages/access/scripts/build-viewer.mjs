import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standalone from "ajv/dist/standalone/index.js";
const root = new URL("../", import.meta.url);
await mkdir(new URL("dist/", root), { recursive: true });
const schema = JSON.parse(
  await readFile(
    new URL("../../contracts/schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ strict: true, code: { source: true, esm: true } });
addFormats(ajv);
ajv.addSchema(schema);
const refs = Object.fromEntries(
  Object.keys(schema.$defs).map((n) => [n, `${schema.$id}#/$defs/${n}`]),
);
await writeFile(new URL("dist/validators.mjs", root), standalone(ajv, refs));
await build({
  entryPoints: [fileURLToPath(new URL("viewer/app.mjs", root))],
  outfile: fileURLToPath(new URL("dist/app.js", root)),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  plugins: [
    {
      name: "shared-contract-browser",
      setup(b) {
        b.onResolve({ filter: /^\.\/contracts\.mjs$/ }, () => ({
          path: fileURLToPath(new URL("viewer/contracts-browser.mjs", root)),
        }));
      },
    },
  ],
});
for (const p of ["index.html", "style.css"])
  await copyFile(new URL("viewer/" + p, root), new URL("dist/" + p, root));
console.log(
  "Viewer built from frozen schema; no runtime eval or Node secret modules.",
);
