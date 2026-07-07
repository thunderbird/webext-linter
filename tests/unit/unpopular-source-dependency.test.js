// Unit tests for the unpopular-source-dependency check (SCA mode), which reads
// addon.vendor.unpopularDeps (a declared dependency that is not a confirmed
// widely-used library - see src/vendor/verify.js verifyScaDependencies) and
// rejects each, anchored at its package.json declaration line.

import { test } from "node:test";
import assert from "node:assert/strict";

import unpopularSourceDependency from "../../src/checks/rules/unpopular-source-dependency.js";

const PKG_JSON = `{
  "dependencies": {
    "@louis.jln/extract-time": "4.0.0",
    "franc": "6.2.0"
  }
}`;

const ctxWith = (unpopularDeps, pkgJson = PKG_JSON) => ({
  addon: {
    files: new Map([["package.json", Buffer.from(pkgJson)]]),
    vendor: { unpopularDeps },
  },
  note() {},
});

test("reports one finding per dep, anchored at its package.json line", () => {
  const ctx = ctxWith([
    {
      name: "@louis.jln/extract-time",
      version: "4.0.0",
      file: "package.json",
      token: "@louis.jln/extract-time",
    },
  ]);
  const out = unpopularSourceDependency.run(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "package.json");
  // The response is collapsible (no {{item}}), so item carries the subject AND
  // version and renders on the location line: "package.json:3 - <item>".
  assert.equal(out[0].item, "@louis.jln/extract-time (4.0.0)");
  assert.equal(out[0].loc.line, 3);
  // severity is left null here - stamped from the registry (error), not the check.
  assert.equal(out[0].severity, null);
});

test("an empty list yields no findings", () => {
  assert.equal(unpopularSourceDependency.run(ctxWith([])).length, 0);
});

test("a missing token anchors at the file with no line", () => {
  const ctx = ctxWith([
    { name: "niche", version: "1.0.0", file: "package.json", token: "" },
  ]);
  const out = unpopularSourceDependency.run(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].loc, null);
});
