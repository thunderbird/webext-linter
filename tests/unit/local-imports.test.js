// Unit tests for the local static-loader parser (import/require/importScripts).

import { test } from "node:test";
import assert from "node:assert/strict";

import { scanLocalImports } from "../../src/parse/local-imports.js";

// Local relative sources of import / export-from / require / importScripts are
// captured; remote sources are left to the remote-resources check; a non-literal
// source sets hasDynamic.
test("scanLocalImports captures local loaders, drops remote, flags dynamic", () => {
  const code = [
    `import "./a.js";`,
    `export { x } from "./b.js";`,
    `const m = require("./c.js");`,
    `importScripts("./w.js", "./w2.js");`,
    `import "https://cdn.example.com/x.js";`, // remote -> dropped
  ].join("\n");
  const r = scanLocalImports(code);
  assert.deepEqual(r.refs.map((x) => x.path).sort(), [
    "./a.js",
    "./b.js",
    "./c.js",
    "./w.js",
    "./w2.js",
  ]);
  assert.equal(r.hasDynamic, false);

  const d = scanLocalImports(`import(name);\nimportScripts(x);`);
  assert.deepEqual(d.refs, []);
  assert.equal(d.hasDynamic, true);
});
