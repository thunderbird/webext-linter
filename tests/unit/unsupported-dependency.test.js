// Unit tests for the unsupported-dependency check, which reads
// addon.vendor.unsupportedDeps (a package.json dep from a source that is neither a
// pinned npm package nor a GitHub URL - see src/vendor/resolve.js resolvePackages)
// and rejects each, anchored at its package.json declaration line.

import { test } from "node:test";
import assert from "node:assert/strict";

import unsupportedDependency from "../../src/checks/rules/unsupported-dependency.js";

const PKG_JSON = `{
  "dependencies": {
    "local": "file:../x",
    "ok": "1.2.3"
  }
}`;

const ctxWith = (unsupportedDeps, pkgJson = PKG_JSON) => ({
  addon: {
    files: new Map([["package.json", Buffer.from(pkgJson)]]),
    vendor: { unsupportedDeps },
  },
  note() {},
});

test("reports one finding per dep, anchored at its package.json line", () => {
  const out = unsupportedDependency.run(
    ctxWith([{ name: "local", spec: "file:../x" }])
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "package.json");
  // Collapsed response: name + spec render together on the location line.
  assert.equal(out[0].item, "local (file:../x)");
  assert.equal(out[0].loc.line, 3); // the "local" declaration line
  assert.equal(out[0].severity, null); // stamped from the registry (error)
});

test("an empty list yields no findings", () => {
  assert.equal(unsupportedDependency.run(ctxWith([])).length, 0);
});

test("a dep whose token is absent from package.json anchors at the file, no line", () => {
  const out = unsupportedDependency.run(
    ctxWith([{ name: "ghost", spec: "file:../y" }])
  );
  assert.equal(out.length, 1);
  assert.ok(!out[0].loc);
});
