// Unit tests for the background-page-module check: a background PAGE
// (background.page HTML) whose <script src> loads ES-module-syntax JS but is
// not declared type="module" fails to load. Inline scripts and the
// background.scripts/service_worker forms are out of scope (the latter is
// background-module.js).

import { test } from "node:test";
import assert from "node:assert/strict";

import rule from "../../src/checks/rules/background-page-module.js";

const addon = (files, manifest) => ({
  manifest,
  files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
});

// Run the rule with a minimal ctx (no ctx.jsSources, so the rule parses the
// referenced files itself - exercising the fallback path).
const run = (files, manifest) =>
  rule
    .run({ addon: addon(files, manifest) })
    .map((f) => `${f.file}:${f.loc?.line}`);

// background.html lines: 1 doctype, 2 head, 3 background.js (module, no type ->
// FAIL), 4 ok.js (module, type=module -> ok), 5 classic.js (no module -> ok),
// 6 inline import (out of scope).
const PAGE = `<!DOCTYPE html><html><head>
<script src="background.js"></script>
<script type="module" src="ok.js"></script>
<script src="classic.js"></script>
<script>import "./helper.js";</script>
</head></html>`;

const FILES = {
  "background.html": PAGE,
  "background.js": 'import { init } from "./helper.js";\ninit();',
  "ok.js": 'import { init } from "./helper.js";\ninit();',
  "classic.js": 'console.log("classic");',
  "helper.js": "export function init() {}",
};

test("flags only the module <script src> that lacks type=module", () => {
  // background.js's tag (line 2) is flagged; the type=module tag (ok.js), the
  // classic script, and the inline import are all left alone.
  assert.deepEqual(run(FILES, { background: { page: "background.html" } }), [
    "background.html:2",
  ]);
});

test("no finding for a background that uses scripts (not a page)", () => {
  // background.scripts is background-module.js's domain, not this check's.
  assert.deepEqual(
    run(
      {
        "background.js": 'import "./helper.js";',
        "helper.js": "export const x = 1;",
      },
      { background: { scripts: ["background.js"] } }
    ),
    []
  );
});

test("no finding when the declared page is absent from the package", () => {
  assert.deepEqual(
    run(
      { "helper.js": "export const x = 1;" },
      {
        background: { page: "background.html" },
      }
    ),
    []
  );
});
