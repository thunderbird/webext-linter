// Unit tests for the unsupported-dependency check, which reads
// addon.vendor.unsupportedDeps (a built XPI's package.json dep from a source that is
// neither a pinned npm package nor a GitHub URL - see src/vendor/resolve.js
// resolvePackages), anchored at its package.json declaration line, and
// addon.vendor.lockLocalInstalls (a source review's local install the archive does not
// hold as a folder - see src/vendor/locks.js localInstalls), anchored at its lock entry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withManifest } from "./manifest-ctx.js";

import unsupportedDependency from "../../src/checks/rules/unsupported-dependency.js";

const PKG_JSON = `{
  "dependencies": {
    "local": "file:../x",
    "ok": "1.2.3"
  }
}`;

const ctxWith = (unsupportedDeps, pkgJson = PKG_JSON) =>
  withManifest({
    artifact: {
      files: new Map([["package.json", Buffer.from(pkgJson)]]),
      vendor: { unsupportedDeps, lockLocalInstalls: [] },
    },
    note() {},
  });

test("reports one finding per dep, anchored at its package.json line", async () => {
  const out = (
    await unsupportedDependency.run(
      ctxWith([{ name: "local", spec: "file:../x", section: "dependencies" }])
    )
  ).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "package.json");
  // Collapsed response: name + spec render together on the location line.
  assert.equal(out[0].item, "local (file:../x)");
  assert.equal(out[0].loc.line, 3); // the "local" declaration line
  assert.equal(out[0].severity, null); // stamped from the registry (error)
});

// The record names the section it was read from, so a name declared in two sections
// anchors at that section's line, not at the first place the name is written.
test("a dep declared in two sections anchors at its own section's line", async () => {
  const pkgJson = `{
  "devDependencies": {
    "local": "^1.0.0"
  },
  "dependencies": {
    "local": "file:../x"
  }
}`;
  const out = (
    await unsupportedDependency.run(
      ctxWith(
        [{ name: "local", spec: "file:../x", section: "dependencies" }],
        pkgJson
      )
    )
  ).findings;
  assert.equal(out[0].loc.line, 6);
});

test("an empty list yields no findings", async () => {
  assert.equal(
    (await unsupportedDependency.run(ctxWith([]))).findings.length,
    0
  );
});

test("a dep whose token is absent from package.json anchors at the file, no line", async () => {
  const out = (
    await unsupportedDependency.run(
      ctxWith([{ name: "ghost", spec: "file:../y", section: "dependencies" }])
    )
  ).findings;
  assert.equal(out.length, 1);
  assert.ok(!out[0].loc);
});

// A comparison-sign-bearing spec reads correctly, not squared() 's unreadable brackets -
// see utf8ComparisonSigns (src/lib/util.js).
test("a spec with comparison signs stays readable in the item", async () => {
  const out = (
    await unsupportedDependency.run(
      ctxWith([
        { name: "weird", spec: ">=4.17.0 <5.0.0", section: "dependencies" },
      ])
    )
  ).findings;
  assert.equal(out[0].item, "weird (≥4.17.0 ＜5.0.0)");
});

// A source review reads the lock: each local install it reports anchors at its own entry,
// a JSON key in an npm lock and a YAML key in a pnpm one.
test("a lock local install anchors at its lock entry", async () => {
  const npmLock = `{
  "packages": {
    "": { "dependencies": { "helper": "file:../shared/helper" } },
    "node_modules/helper": { "resolved": "../shared/helper", "link": true }
  }
}`;
  const pnpmLock = [
    "importers:",
    "  .:",
    "    dependencies:",
    "      far:",
    "        specifier: link:../far",
    "        version: link:../far",
    "",
  ].join("\n");
  const out = (
    await unsupportedDependency.run(
      withManifest({
        artifact: {
          files: new Map([
            ["package-lock.json", Buffer.from(npmLock)],
            ["pnpm-lock.yaml", Buffer.from(pnpmLock)],
          ]),
          vendor: {
            unsupportedDeps: [],
            lockLocalInstalls: [
              {
                name: "helper",
                spec: "../shared/helper",
                file: "package-lock.json",
                token: "node_modules/helper",
              },
              {
                name: "far",
                spec: "link:../far",
                file: "pnpm-lock.yaml",
                token: "far",
              },
            ],
          },
        },
        note() {},
      })
    )
  ).findings;
  assert.deepEqual(
    out.map((f) => [f.file, f.loc?.line, f.item]),
    [
      ["package-lock.json", 4, "helper (../shared/helper)"],
      ["pnpm-lock.yaml", 4, "far (link:../far)"],
    ]
  );
});
