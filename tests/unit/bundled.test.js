// Unit tests for the bundled-JS classification "check memory": classifyBundled
// (the one-shot, addon-keyed pre-step), the build/lint correctness fix (the
// classification is computed before normalize, so a reformatted minified file is
// still caught), and the per-review memoization the readers share.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyBundled,
  classifyAddonJs,
} from "../../src/checks/lib/bundled.js";
import obfuscatedCode from "../../src/checks/rules/obfuscated-code.js";

// One long, dense line (no newline): minified by geometry, not by name, so it
// exercises the heuristic rather than the ".min.js" / library-name shortcut.
const MINIFIED = `var data=[${"1,".repeat(700)}1];`;
// Readable, multi-line, still >= 1024 bytes so it is classified (not skipped):
// short lines, low density -> NOT minified. This is what prettier would produce.
const PRETTY = "const x = 1;\n".repeat(120);

const addonWith = (files) => ({
  files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
});

test("classifyBundled flags an undeclared minified-by-geometry file", () => {
  const { classified, nonAuthored } = classifyBundled(
    addonWith({ "lib/blob.js": MINIFIED })
  );
  const tag = classified.find((c) => c.file === "lib/blob.js");
  assert.deepEqual(
    [tag.minified, tag.library, tag.obfuscated],
    [true, false, false]
  );
  assert.ok(nonAuthored.has("lib/blob.js"));
});

test("classification done before normalize survives reformatting (the fix)", () => {
  const addon = addonWith({ "lib/blob.js": MINIFIED });
  // Pipeline pre-step: classify BEFORE normalize.
  addon.bundled = classifyBundled(addon);
  // Normalize reformats the file in place (build/lint mode).
  addon.files.set("lib/blob.js", Buffer.from(PRETTY));
  // The check reads the pre-step store, so the minified file is still flagged.
  const flagged = obfuscatedCode.run({ addon }).map((f) => f.file);
  assert.deepEqual(flagged, ["lib/blob.js"]);
});

test("without the pre-step, classifying the reformatted bytes misses it", () => {
  // No addon.bundled: the reader recomputes over the already-pretty bytes, which
  // no longer look minified - the build/lint false negative the pre-step fixes.
  const flagged = obfuscatedCode
    .run({ addon: addonWith({ "lib/blob.js": PRETTY }) })
    .map((f) => f.file);
  assert.deepEqual(flagged, []);
});

test("the classification is memoized: readers share one computation", () => {
  const ctx = { addon: addonWith({ "lib/blob.js": MINIFIED }) };
  assert.strictEqual(classifyAddonJs(ctx), classifyAddonJs(ctx));
});
