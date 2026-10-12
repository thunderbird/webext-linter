// Unit tests for the lock file's install check (src/vendor/locks.js lockInstallTargets /
// findLockInjections): every registry entry must install the release it names. The audit asks
// about the name and version an entry records, while the install fetches its URL, so an entry
// whose URL is another release is forged. A URL on the registry's tarball path is compared
// offline; one off it is asked of the registry, once, and the answer cached. No network: a
// lookup is answered by a fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findLockInjections,
  lockInstallTargets,
} from "../../src/vendor/locks.js";

const REG = "https://registry.npmjs.org/";

function fakeAddon(files) {
  const map = new Map();
  for (const [k, v] of Object.entries(files)) {
    map.set(k, Buffer.from(v));
  }
  return { files: map, directories: [] };
}

/** An npm lockfile v3 holding `packages` beside its root record. */
const npmV3 = (packages) =>
  fakeAddon({
    "package.json": JSON.stringify({ name: "x" }),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { name: "x" }, ...packages },
    }),
  });

/** An npm lockfile v1 holding `dependencies`. */
const npmV1 = (dependencies) =>
  fakeAddon({
    "package.json": JSON.stringify({ name: "x" }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 1, dependencies }),
  });

/** A pnpm v9 lock: `packages` as YAML, written by hand. */
const pnpm = (packagesYaml) =>
  fakeAddon({
    "package.json": JSON.stringify({ name: "x" }),
    "pnpm-lock.yaml": `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\npackages:\n${packagesYaml}`,
  });

/** A network that fails the test on any request. */
const noNet = {
  fetchJson: async () => assert.fail("no request expected"),
};

/** An empty cache folder of the test's own. */
const freshCache = () => fs.mkdtempSync(path.join(os.tmpdir(), "wl-npm-reg-"));

/** The forged entries, as [name, version, installed]. */
async function forged(addon, opts = { net: noNet, cacheDir: freshCache() }) {
  return (await findLockInjections(addon, opts)).map((f) => [
    f.name,
    f.version,
    f.installed,
  ]);
}

test("an honest lock installs what it names, in every format", async () => {
  const v3 = npmV3({
    "node_modules/tinylib": {
      version: "1.2.1",
      resolved: `${REG}tinylib/-/tinylib-1.2.1.tgz`,
    },
    "node_modules/@scope/pkg": {
      version: "2.0.0",
      resolved: `${REG}@scope/pkg/-/pkg-2.0.0.tgz`,
    },
    // No `resolved`: the registry's own tarball, found by integrity.
    "node_modules/bare": { version: "1.0.0", integrity: "sha512-x" },
  });
  const v1 = npmV1({
    tinylib: {
      version: "1.2.1",
      resolved: `${REG}tinylib/-/tinylib-1.2.1.tgz`,
    },
  });
  const p = pnpm("  tinylib@1.2.1:\n    resolution: {integrity: sha512-x}\n");
  for (const addon of [v3, v1, p]) {
    assert.deepEqual(await forged(addon), []);
  }
  assert.equal(lockInstallTargets(v3).length, 3);
});

test("a version that is not the tarball's release is forged", async () => {
  const addon = npmV3({
    "node_modules/tinylib": {
      version: "1.2.2",
      resolved: `${REG}tinylib/-/tinylib-1.2.1.tgz`,
    },
  });
  assert.deepEqual(await forged(addon), [
    ["tinylib", "1.2.2", "tinylib@1.2.1"],
  ]);
});

test("a tarball of another package is forged, scoped or not", async () => {
  const addon = npmV3({
    "node_modules/tinylib": {
      version: "1.2.1",
      resolved: `${REG}evil/-/evil-1.2.1.tgz`,
    },
    "node_modules/@scope/pkg": {
      version: "2.0.0",
      resolved: `${REG}@other/pkg/-/pkg-2.0.0.tgz`,
    },
  });
  assert.deepEqual(await forged(addon), [
    ["tinylib", "1.2.1", "evil@1.2.1"],
    ["@scope/pkg", "2.0.0", "@other/pkg@2.0.0"],
  ]);
});

test("a lockfile v1 entry is compared, and its npm: alias names the real package", async () => {
  const addon = npmV1({
    tinylib: {
      version: "1.2.2",
      resolved: `${REG}tinylib/-/tinylib-1.2.1.tgz`,
      dependencies: {
        nested: {
          version: "0.1.0",
          resolved: `${REG}nested/-/nested-0.2.0.tgz`,
        },
      },
    },
    alias: {
      version: "npm:real@3.0.0",
      resolved: `${REG}real/-/real-3.0.0.tgz`,
    },
  });
  assert.deepEqual(await forged(addon), [
    ["tinylib", "1.2.2", "tinylib@1.2.1"],
    ["nested", "0.1.0", "nested@0.2.0"],
  ]);
});

test("a pnpm resolution.tarball is compared with the entry's name and version", async () => {
  const addon = pnpm(
    `  tinylib@1.2.2:\n    resolution: {integrity: sha512-x, tarball: '${REG}tinylib/-/tinylib-1.2.1.tgz'}\n`
  );
  assert.deepEqual(await forged(addon), [
    ["tinylib", "1.2.2", "tinylib@1.2.1"],
  ]);
});

test("every registry entry is compared, whatever its version looks like", async () => {
  const addon = npmV3({
    "node_modules/tinylib": {
      version: "github:me/tinylib",
      resolved: `${REG}tinylib/-/tinylib-1.2.1.tgz`,
    },
  });
  assert.deepEqual(await forged(addon), [
    ["tinylib", "github:me/tinylib", "tinylib@1.2.1"],
  ]);
});

test("an alias and a bundled package are not forged", async () => {
  const addon = npmV3({
    // npm records an alias's real package in `name`.
    "node_modules/alias": {
      name: "real",
      version: "3.0.0",
      resolved: `${REG}real/-/real-3.0.0.tgz`,
    },
    // Installed inside its parent's tarball: it fetches nothing of its own.
    "node_modules/parent/node_modules/inner": {
      version: "1.0.0",
      inBundle: true,
      resolved: `${REG}other/-/other-9.9.9.tgz`,
    },
  });
  assert.deepEqual(await forged(addon), []);
});

test("an encoded scope slash and a query string read as the URL the install fetches", async () => {
  const addon = npmV3({
    "node_modules/@scope/pkg": {
      version: "2.0.0",
      resolved: `${REG}@scope%2fpkg/-/pkg-2.0.0.tgz?cache=1`,
    },
    "node_modules/@scope/other": {
      version: "2.0.0",
      resolved: `${REG}@scope%2Fother/-/other-2.0.1.tgz?cache=1`,
    },
  });
  assert.deepEqual(await forged(addon), [
    ["@scope/other", "2.0.0", "@scope/other@2.0.1"],
  ]);
});

test("a registry URL off the tarball path is asked of the registry, and its tarball cached", async () => {
  const odd = `${REG}tinylib/-/release.tgz`;
  const addon = npmV3({
    "node_modules/tinylib": { version: "1.2.1", resolved: odd },
    "node_modules/mismatch": {
      version: "1.0.0",
      resolved: `${REG}mismatch/-/elsewhere.tgz`,
    },
    "node_modules/@scope/gone": {
      version: "0.0.1",
      resolved: `${REG}@scope/gone/-/x.tgz`,
    },
  });
  const asked = [];
  const net = {
    fetchJson: async (url) => {
      asked.push(url);
      if (url === `${REG}tinylib/1.2.1`) {
        return { dist: { tarball: odd } };
      }
      if (url === `${REG}mismatch/1.0.0`) {
        return { dist: { tarball: `${REG}mismatch/-/mismatch-1.0.0.tgz` } };
      }
      const err = new Error("Not Found");
      err.status = 404;
      throw err;
    },
  };
  const cacheDir = freshCache();
  const expected = [
    ["mismatch", "1.0.0", `${REG}mismatch/-/elsewhere.tgz`],
    ["@scope/gone", "0.0.1", `${REG}@scope/gone/-/x.tgz`],
  ];
  assert.deepEqual(await forged(addon, { net, cacheDir }), expected);
  assert.deepEqual(asked, [
    `${REG}tinylib/1.2.1`,
    `${REG}mismatch/1.0.0`,
    `${REG}@scope%2fgone/0.0.1`,
  ]);
  // The second run is answered from the cache - except the 404, which is never kept (it can
  // be a passing fault of the registry) and so is asked again.
  const again = [];
  const recording = {
    fetchJson: async (url) => {
      again.push(url);
      return net.fetchJson(url);
    },
  };
  assert.deepEqual(await forged(addon, { net: recording, cacheDir }), expected);
  assert.deepEqual(again, [`${REG}@scope%2fgone/0.0.1`]);
  // A pre-filled 404 (`{fake404: true}`) is read, as every test runs with the network
  // switched off; an older version's `null` is not, and is asked again.
  const file = path.join(cacheDir, "npm-registry.json");
  const kept = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    file,
    JSON.stringify({ ...kept, "@scope/gone@0.0.1": { fake404: true } })
  );
  assert.deepEqual(await forged(addon, { net: noNet, cacheDir }), expected);
  fs.writeFileSync(
    file,
    JSON.stringify({ ...kept, "@scope/gone@0.0.1": null })
  );
  again.length = 0;
  assert.deepEqual(await forged(addon, { net: recording, cacheDir }), expected);
  assert.deepEqual(again, [`${REG}@scope%2fgone/0.0.1`]);
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("an answer other than a 404 is not read as one", async () => {
  const addon = npmV3({
    "node_modules/tinylib": {
      version: "1.2.1",
      resolved: `${REG}tinylib/-/release.tgz`,
    },
  });
  const net = {
    fetchJson: async () => {
      const err = new Error("Service Unavailable");
      err.status = 503;
      throw err;
    },
  };
  await assert.rejects(
    () => findLockInjections(addon, { net, cacheDir: freshCache() }),
    /Service Unavailable/
  );
});
