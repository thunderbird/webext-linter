// Unit tests for lock-file version resolution (src/vendor/locks.js) across npm,
// pnpm, and yarn, and for resolveVendor's package.json dependency resolution
// (exact pin / range+lock -> pinned, range without a lock -> unpinned, a
// non-registry spec -> ignored). No network.

import { test } from "node:test";
import assert from "node:assert/strict";

import { lockedVersion } from "../../src/vendor/locks.js";
import { resolveVendor } from "../../src/vendor/resolve.js";

function fakeAddon(files) {
  const map = new Map();
  for (const [k, v] of Object.entries(files)) {
    map.set(k, Buffer.from(v));
  }
  return { files: map };
}

// ---- lockedVersion ----

test("npm lockfile v3 (packages) and v1 (dependencies)", () => {
  const v3 = fakeAddon({
    "package-lock.json": JSON.stringify({
      packages: { "node_modules/jszip": { version: "3.10.1" } },
    }),
  });
  assert.equal(lockedVersion(v3, "jszip"), "3.10.1");

  const v1 = fakeAddon({
    "package-lock.json": JSON.stringify({
      dependencies: { jszip: { version: "3.9.0" } },
    }),
  });
  assert.equal(lockedVersion(v1, "jszip"), "3.9.0");
});

test("npm-shrinkwrap.json is read like package-lock.json", () => {
  const addon = fakeAddon({
    "npm-shrinkwrap.json": JSON.stringify({
      packages: { "node_modules/foo": { version: "1.2.3" } },
    }),
  });
  assert.equal(lockedVersion(addon, "foo"), "1.2.3");
});

test("pnpm lockfile: importers entry and packages-key fallback, peer suffix stripped", () => {
  const importer = fakeAddon({
    "pnpm-lock.yaml":
      "importers:\n  .:\n    dependencies:\n      jszip:\n        version: 3.10.1(react@18)\n",
  });
  assert.equal(lockedVersion(importer, "jszip"), "3.10.1");

  const pkgKey = fakeAddon({
    "pnpm-lock.yaml": "packages:\n  /jszip@3.7.1:\n    resolution: {}\n",
  });
  assert.equal(lockedVersion(pkgKey, "jszip"), "3.7.1");
});

test("yarn.lock: v1 custom format and berry YAML", () => {
  const v1 = fakeAddon({
    "yarn.lock":
      '# yarn lockfile v1\n\n"jszip@^3.10.0":\n  version "3.10.1"\n  resolved "x"\n',
  });
  assert.equal(lockedVersion(v1, "jszip"), "3.10.1");

  const berry = fakeAddon({
    "yarn.lock":
      '__metadata:\n  version: 8\n\n"jszip@npm:^3.10.0":\n  version: 3.10.1\n  resolution: "jszip@npm:3.10.1"\n',
  });
  assert.equal(lockedVersion(berry, "jszip"), "3.10.1");
});

test("lockedVersion returns null when no lock resolves the name", () => {
  assert.equal(lockedVersion(fakeAddon({}), "jszip"), null);
  const other = fakeAddon({
    "package-lock.json": JSON.stringify({
      packages: { "node_modules/other": { version: "1.0.0" } },
    }),
  });
  assert.equal(lockedVersion(other, "jszip"), null);
});

// ---- resolveVendor: package.json dependency resolution ----

async function resolvePackages(files) {
  const { packages, unpinned } = await resolveVendor({
    addon: fakeAddon(files),
    token: undefined,
  });
  return { packages, unpinned };
}

test("an exact-pinned dependency is a verify source", async () => {
  const { packages, unpinned } = await resolvePackages({
    "package.json": JSON.stringify({ dependencies: { jszip: "3.10.1" } }),
  });
  assert.deepEqual(packages, [{ name: "jszip", version: "3.10.1" }]);
  assert.deepEqual(unpinned, []);
});

test("a range with a lock is pinned to the locked version", async () => {
  const { packages, unpinned } = await resolvePackages({
    "package.json": JSON.stringify({ dependencies: { jszip: "^3.10.0" } }),
    "package-lock.json": JSON.stringify({
      packages: { "node_modules/jszip": { version: "3.10.1" } },
    }),
  });
  assert.deepEqual(packages, [{ name: "jszip", version: "3.10.1" }]);
  assert.deepEqual(unpinned, []);
});

test("a range with no lock is unpinned (rejected, not a verify source)", async () => {
  const { packages, unpinned } = await resolvePackages({
    "package.json": JSON.stringify({ dependencies: { jszip: "^3.10.0" } }),
  });
  assert.deepEqual(packages, []);
  assert.deepEqual(unpinned, [{ name: "jszip", spec: "^3.10.0" }]);
});

test("a non-registry spec (git/file) is ignored, not flagged", async () => {
  const { packages, unpinned } = await resolvePackages({
    "package.json": JSON.stringify({
      dependencies: { foo: "github:user/repo#v1", bar: "file:../bar" },
    }),
  });
  assert.deepEqual(packages, []);
  assert.deepEqual(unpinned, []);
});
