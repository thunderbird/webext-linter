// Unit tests for the unpopular-source-dependency check (SCA mode), which reads
// addon.vendor.unpopularDeps (a package the lock marks as declared that is not a
// confirmed widely-used library - see src/vendor/verify.js verifyScaDependencies) and
// rejects each, anchored at the line its token locates - the package's lock entry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withManifest } from "./manifest-ctx.js";

import unpopularSourceDependency from "../../src/checks/rules/unpopular-source-dependency.js";

const PKG_JSON = `{
  "dependencies": {
    "@quill-fixture/extract-time": "4.0.0",
    "franc": "6.2.0"
  }
}`;

const ctxWith = (unpopularDeps, pkgJson = PKG_JSON) => ({
  artifact: {
    files: new Map([["package.json", Buffer.from(pkgJson)]]),
    vendor: { unpopularDeps },
  },
  note() {},
});

test("reports one finding per dep, anchored at its package.json line", () => {
  const ctx = ctxWith([
    {
      name: "@quill-fixture/extract-time",
      version: "4.0.0",
      file: "package.json",
      token: "@quill-fixture/extract-time",
    },
  ]);
  const out = unpopularSourceDependency.run(withManifest(ctx)).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "package.json");
  // The response is collapsible (no {{item}}), so item carries the subject AND
  // version and renders on the location line: "package.json:3 - <item>".
  assert.equal(out[0].item, "@quill-fixture/extract-time (4.0.0)");
  assert.equal(out[0].loc.line, 3);
  // severity is left null here - stamped from the registry (error), not the check.
  assert.equal(out[0].severity, null);
});

test("an empty list yields no findings", () => {
  assert.equal(unpopularSourceDependency.run(ctxWith([])).findings.length, 0);
});

test("a missing token anchors at the file with no line", () => {
  const ctx = ctxWith([
    { name: "niche", version: "1.0.0", file: "package.json", token: "" },
  ]);
  const out = unpopularSourceDependency.run(withManifest(ctx)).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].loc, null);
});

// What verifyScaDependencies records is the lock entry: a JSON key in an npm lock, a YAML
// key in a pnpm one.
test("a lock entry anchors at its key in the lock", () => {
  const npmLock = `{
  "packages": {
    "": { "dependencies": { "niche": "1.0.0" } },
    "node_modules/niche": { "version": "1.0.0" }
  }
}`;
  const pnpmLock = [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    "      rare:",
    "        specifier: 2.0.0",
    "        version: 2.0.0",
    "packages:",
    "  rare@2.0.0:",
    "    resolution: {integrity: sha512-x}",
    "",
  ].join("\n");
  const ctx = {
    artifact: {
      files: new Map([
        ["package-lock.json", Buffer.from(npmLock)],
        ["pnpm-lock.yaml", Buffer.from(pnpmLock)],
      ]),
      vendor: {
        unpopularDeps: [
          {
            name: "niche",
            version: "1.0.0",
            file: "package-lock.json",
            token: "node_modules/niche",
          },
          {
            name: "rare",
            version: "2.0.0",
            file: "pnpm-lock.yaml",
            token: "rare@2.0.0",
          },
        ],
      },
    },
    note() {},
  };
  const out = unpopularSourceDependency.run(withManifest(ctx)).findings;
  assert.deepEqual(
    out.map((f) => [f.file, f.loc?.line]),
    [
      ["package-lock.json", 4],
      ["pnpm-lock.yaml", 9],
    ]
  );
});
