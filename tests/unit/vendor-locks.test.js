// Unit tests for the lock-file readers (src/vendor/locks.js): version resolution
// for one declared name across npm, pnpm, and yarn (lockedVersion), enumeration
// of the whole installed tree across npm v1/v2/v3 and pnpm v5-v9
// (lockedPackages), and resolveVendor's package.json dependency resolution
// (exact pin / range+lock -> pinned, range without a lock -> unpinned, a
// non-registry spec -> ignored). No network.

import { test } from "node:test";
import assert from "node:assert/strict";

import { lockedVersion, lockedPackages } from "../../src/vendor/locks.js";
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

// ---- lockedPackages ----

/**
 * The enumeration as "name@version" strings, for compact assertions.
 * @param {object} addon @returns {string[]}
 */
function names(addon) {
  return lockedPackages(addon).map((p) => `${p.name}@${p.version}`);
}

// The whole point of the enumeration: a package no manifest mentions, reached
// only through another package's node_modules, is still installed and still
// audited. The name comes from the LAST node_modules segment, so depth does not
// mangle it, and a scoped name survives its own slash.
test("npm v3 enumerates nested and scoped packages", () => {
  const addon = fakeAddon({
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "the-addon", dependencies: { svgo: "^3.0.0" } },
        "node_modules/svgo": { version: "3.0.2" },
        "node_modules/svgo/node_modules/nth-check": { version: "2.0.0" },
        "node_modules/@babel/parser": { version: "7.29.8" },
      },
    }),
  });
  assert.deepEqual(names(addon), [
    "@babel/parser@7.29.8",
    "nth-check@2.0.0",
    "svgo@3.0.2",
  ]);
  // The anchor is the full key, which is what the lock file's own line says.
  assert.equal(
    lockedPackages(addon).find((p) => p.name === "nth-check").token,
    "node_modules/svgo/node_modules/nth-check"
  );
});

// npm records an alias by keeping the real package under `name` while the
// DIRECTORY carries the alias. Auditing the directory name would query a package
// that does not exist, so the real one wins.
test("npm v3 resolves an aliased package to its real name", () => {
  const addon = fakeAddon({
    "package-lock.json": JSON.stringify({
      packages: {
        "node_modules/my-lodash": { name: "lodash", version: "4.17.20" },
      },
    }),
  });
  assert.deepEqual(names(addon), ["lodash@4.17.20"]);
});

// Three kinds of entry are not an installed registry release, and auditing any of
// them by name would invent a package: the project root, a workspace member (the
// submission's own code, under no node_modules), and a symlink to one.
test("npm v3 skips the root, workspace members and links", () => {
  const addon = fakeAddon({
    "package-lock.json": JSON.stringify({
      packages: {
        "": { name: "the-addon", version: "1.0.0" },
        "packages/ui": { name: "@addon/ui", version: "0.1.0" },
        "node_modules/@addon/ui": { resolved: "packages/ui", link: true },
        "node_modules/real": { version: "2.0.0" },
      },
    }),
  });
  assert.deepEqual(names(addon), ["real@2.0.0"]);
});

// A git or file install is not the registry release of that name. Querying OSV
// for it would answer about a package the build never fetched.
test("npm v3 skips non-registry sources and non-numeric versions", () => {
  const addon = fakeAddon({
    "package-lock.json": JSON.stringify({
      packages: {
        "node_modules/from-git": {
          version: "1.0.0",
          resolved: "git+ssh://git@github.com/o/r.git#abc",
        },
        "node_modules/from-file": { version: "1.0.0", resolved: "file:../lib" },
        "node_modules/weird": { version: "workspace:*" },
        "node_modules/ok": { version: "1.2.3" },
      },
    }),
  });
  assert.deepEqual(names(addon), ["ok@1.2.3"]);
});

// `devOptional` means dev HERE and production somewhere else in the same tree, so
// the package does ship - only a plain `dev` marks it build-time only.
test("npm v3 reads dev, and routes devOptional to production", () => {
  const addon = fakeAddon({
    "package-lock.json": JSON.stringify({
      packages: {
        "node_modules/builder": { version: "1.0.0", dev: true },
        "node_modules/both": { version: "2.0.0", devOptional: true },
        "node_modules/shipped": { version: "3.0.0" },
      },
    }),
  });
  const byName = Object.fromEntries(
    lockedPackages(addon).map((p) => [p.name, p.dev])
  );
  assert.deepEqual(byName, { builder: true, both: false, shipped: false });
});

// lockfileVersion 1 nests each package's own dependencies instead of flattening
// them, so the whole tree is only reachable by recursion.
test("npm v1 walks the nested dependencies tree", () => {
  const addon = fakeAddon({
    "package-lock.json": JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        grunt: {
          version: "1.0.0",
          dev: true,
          dependencies: {
            "deep-tool": { version: "0.5.0", dev: true },
          },
        },
        shipped: { version: "2.0.0" },
      },
    }),
  });
  assert.deepEqual(names(addon), [
    "deep-tool@0.5.0",
    "grunt@1.0.0",
    "shipped@2.0.0",
  ]);
  assert.equal(
    lockedPackages(addon).find((p) => p.name === "deep-tool").token,
    "deep-tool"
  );
});

// pnpm wrote its packages keys three different ways. All three name the same two
// things, so all three enumerate, and the peer-dependency tail is not a version.
test("pnpm reads v5, v6-v8 and v9 packages keys", () => {
  const v5 = fakeAddon({
    "pnpm-lock.yaml": "packages:\n  /chart.js/4.5.1:\n    dev: false\n",
  });
  assert.deepEqual(names(v5), ["chart.js@4.5.1"]);

  const v6 = fakeAddon({
    "pnpm-lock.yaml":
      "packages:\n  /@babel/parser@7.29.8:\n    dev: true\n" +
      "  /chartjs-adapter@3.0.0(chart.js@4.5.1):\n    dev: false\n",
  });
  assert.deepEqual(names(v6), [
    "@babel/parser@7.29.8",
    "chartjs-adapter@3.0.0",
  ]);
  assert.equal(lockedPackages(v6)[0].dev, true);
  assert.equal(lockedPackages(v6)[1].dev, false);
});

// pnpm v9 dropped the per-package dev flag, so "is this shipped?" becomes a
// reachability question: whatever the importers' production dependencies reach
// through the snapshot edges ships, and the rest is build-time only.
test("pnpm v9 derives dev from reachability, in both directions", () => {
  const addon = fakeAddon({
    "pnpm-lock.yaml": [
      "importers:",
      "  .:",
      "    dependencies:",
      "      vue:",
      "        specifier: ^3.5.41",
      "        version: 3.5.41",
      "    devDependencies:",
      "      vite:",
      "        specifier: ^8.0.0",
      "        version: 8.2.2",
      "packages:",
      "  vue@3.5.41: {}",
      "  '@vue/shared@3.5.41': {}",
      "  vite@8.2.2: {}",
      "  esbuild@0.25.0: {}",
      "snapshots:",
      "  vue@3.5.41:",
      "    dependencies:",
      "      '@vue/shared': 3.5.41",
      "  '@vue/shared@3.5.41': {}",
      "  vite@8.2.2:",
      "    dependencies:",
      "      esbuild: 0.25.0",
      "  esbuild@0.25.0: {}",
    ].join("\n"),
  });
  const byName = Object.fromEntries(
    lockedPackages(addon).map((p) => [p.name, p.dev])
  );
  // vue is declared production, and what it pulls in ships with it.
  assert.equal(byName["vue"], false);
  assert.equal(byName["@vue/shared"], false);
  // vite is declared dev, so neither it nor what it pulls in ever ships.
  assert.equal(byName["vite"], true);
  assert.equal(byName["esbuild"], true);
});

// A snapshot key carries a peer-dependency tail that the packages key does not,
// so reachability has to be matched on the bare name@version both reduce to -
// otherwise every package with a peer dependency would read as build-time only.
test("pnpm v9 reaches a package through a peer-suffixed snapshot key", () => {
  const addon = fakeAddon({
    "pnpm-lock.yaml": [
      "importers:",
      "  .:",
      "    dependencies:",
      "      adapter:",
      "        specifier: ^3.0.0",
      "        version: 3.0.0(chart.js@4.5.1)",
      "packages:",
      "  adapter@3.0.0: {}",
      "snapshots:",
      "  adapter@3.0.0(chart.js@4.5.1): {}",
    ].join("\n"),
  });
  assert.deepEqual(lockedPackages(addon)[0].dev, false);
});

// Without a snapshots map there is no graph to walk. Calling everything dev-only
// would silently move real shipped packages into the build-time check, so the
// safe reading is the shipped one.
test("pnpm falls back to production with no snapshots and no dev flags", () => {
  const addon = fakeAddon({
    "pnpm-lock.yaml": "packages:\n  /lib@1.0.0:\n    resolution: {}\n",
  });
  assert.deepEqual(lockedPackages(addon), [
    {
      name: "lib",
      version: "1.0.0",
      dev: false,
      direct: false,
      file: "pnpm-lock.yaml",
      token: "/lib@1.0.0",
    },
  ]);
});

// One package can be installed at several paths. It is one package to audit, and
// a copy installed for production anywhere means it ships - so the duplicate
// collapses, keeping the first (shallowest) anchor and the production reading.
test("the same name@version collapses to one entry, production winning", () => {
  const addon = fakeAddon({
    "package-lock.json": JSON.stringify({
      packages: {
        "node_modules/dup": { version: "1.0.0", dev: true },
        "node_modules/a/node_modules/dup": { version: "1.0.0" },
        "node_modules/dup2": { version: "2.0.0" },
      },
    }),
  });
  const found = lockedPackages(addon);
  assert.deepEqual(names(addon), ["dup@1.0.0", "dup2@2.0.0"]);
  assert.equal(found[0].token, "node_modules/dup");
  assert.equal(found[0].dev, false);
});

// The batch audit sends these positionally, so the order is part of the contract:
// an unstable one would move each OSV answer onto a different package.
test("the enumeration is sorted by name, then version", () => {
  const addon = fakeAddon({
    "package-lock.json": JSON.stringify({
      packages: {
        "node_modules/zzz": { version: "1.0.0" },
        "node_modules/aaa": { version: "2.0.0" },
        "node_modules/a/node_modules/aaa": { version: "10.0.0" },
      },
    }),
  });
  assert.deepEqual(names(addon), ["aaa@10.0.0", "aaa@2.0.0", "zzz@1.0.0"]);
});

// Nothing to enumerate must read as nothing, never as a throw: an unparseable or
// unsupported lock leaves the audit silent rather than failing the review.
test("an absent, empty, malformed or yarn-only lock enumerates nothing", () => {
  assert.deepEqual(lockedPackages(fakeAddon({ "package.json": "{}" })), []);
  assert.deepEqual(
    lockedPackages(fakeAddon({ "package-lock.json": "{}" })),
    []
  );
  assert.deepEqual(
    lockedPackages(fakeAddon({ "package-lock.json": "{not json" })),
    []
  );
  assert.deepEqual(lockedPackages(fakeAddon({ "pnpm-lock.yaml": "x: [" })), []);
  // Yarn is deliberately not enumerated: a committed yarn.lock is already a hard
  // reject, and the format records nothing about what is build-time only.
  assert.deepEqual(
    lockedPackages(
      fakeAddon({ "yarn.lock": 'lib@^1.0.0:\n  version "1.0.0"\n' })
    ),
    []
  );
  assert.deepEqual(lockedPackages({}), []);
});

// Two locks describe the same install. Reading both would report every package
// twice, so only the first that yields anything is enumerated.
test("only the first lock that yields packages is read", () => {
  const addon = fakeAddon({
    "package-lock.json": JSON.stringify({
      packages: { "node_modules/from-npm": { version: "1.0.0" } },
    }),
    "pnpm-lock.yaml": "packages:\n  /from-pnpm@2.0.0:\n    dev: false\n",
  });
  assert.deepEqual(names(addon), ["from-npm@1.0.0"]);
});

// Both questions read the same file, and the parse is memoized per add-on - so
// the answers must not start depending on which one was asked first.
test("lockedVersion and lockedPackages agree through the shared parse", () => {
  const addon = fakeAddon({
    "package-lock.json": JSON.stringify({
      packages: {
        "node_modules/jszip": { version: "3.10.1" },
        "node_modules/other/node_modules/jszip": { version: "2.0.0" },
      },
    }),
  });
  assert.equal(lockedVersion(addon, "jszip"), "3.10.1");
  assert.deepEqual(names(addon), ["jszip@2.0.0", "jszip@3.10.1"]);
  // ...and the other way round, with the cache already warm.
  assert.equal(lockedVersion(addon, "jszip"), "3.10.1");
});

// ---- lockedPackages: which packages the submission asked for ----

/** The names the enumeration marks as declared by the submission itself. */
function declared(addon) {
  return lockedPackages(addon)
    .filter((p) => p.direct)
    .map((p) => p.name);
}

// Directness is read from the lock rather than from the root package.json,
// because the lock records declaration forms that parse misses. Getting this
// wrong is not a missed finding but a FALSE one: the developer is told the
// add-on does not declare a package they wrote down themselves.
test("a package any manifest in the lock asks for is marked declared", () => {
  const addon = fakeAddon({
    "package-lock.json": JSON.stringify({
      packages: {
        // optionalDependencies is a declaration; the root package.json parse
        // deliberately reads only dependencies + devDependencies.
        "": { name: "root", optionalDependencies: { "opt-dep": "^2.0.0" } },
        // A workspace member's own manifest is a declaration too.
        "packages/app": { name: "app", dependencies: { "nth-check": "2.0.0" } },
        // The lock's version may differ from the range that asked for it.
        "node_modules/opt-dep": { version: "2.1.0" },
        "node_modules/nth-check": { version: "2.0.0" },
        "node_modules/pulled-in": { version: "1.0.0" },
      },
    }),
  });
  assert.deepEqual(declared(addon).sort(), ["nth-check", "opt-dep"]);
  assert.equal(
    lockedPackages(addon).find((p) => p.name === "pulled-in").direct,
    false
  );
});

// An "npm:" alias installs a package under a different name, and the tree records
// the REAL one - so matching the written name would leave an aliased dependency
// looking like a package nobody asked for.
test("an aliased declaration is matched by the package it installs", () => {
  const npm = fakeAddon({
    "package-lock.json": JSON.stringify({
      packages: {
        "": { dependencies: { "my-lodash": "npm:lodash@^4.0.0" } },
        "node_modules/my-lodash": { name: "lodash", version: "4.17.20" },
      },
    }),
  });
  assert.deepEqual(declared(npm), ["lodash"]);

  const pnpm = fakeAddon({
    "pnpm-lock.yaml": [
      "importers:",
      "  .:",
      "    dependencies:",
      "      string-width-cjs:",
      "        specifier: npm:string-width@^4.2.0",
      "        version: string-width@4.2.3",
      "packages:",
      "  string-width@4.2.3: {}",
      "snapshots:",
      "  string-width@4.2.3: {}",
    ].join("\n"),
  });
  assert.deepEqual(declared(pnpm), ["string-width"]);
});

// Under an alias the dependency VALUE is the target's own "name@version", which
// already names the snapshot. Prefixing the alias name onto it would build a key
// nothing answers to, and the target plus its whole subtree would read as
// build-time only - reporting shipped code as something that only runs on the
// reviewer's machine.
test("pnpm v9 follows an aliased edge, keeping its subtree in production", () => {
  const addon = fakeAddon({
    "pnpm-lock.yaml": [
      "importers:",
      "  .:",
      "    dependencies:",
      "      string-width-cjs:",
      "        specifier: npm:string-width@^4.2.0",
      "        version: string-width@4.2.3",
      "packages:",
      "  string-width@4.2.3: {}",
      "  deep@1.0.0: {}",
      "snapshots:",
      "  string-width@4.2.3:",
      "    dependencies:",
      "      deep: 1.0.0",
      "  deep@1.0.0: {}",
    ].join("\n"),
  });
  const byName = Object.fromEntries(
    lockedPackages(addon).map((p) => [p.name, p.dev])
  );
  assert.deepEqual(byName, { deep: false, "string-width": false });
});

// The nesting depth of a v1 lock is whatever the submitted file says. A few
// thousand levels is a couple of hundred KB to write, so walking it by recursion
// would let a submission exhaust the call stack and abort its own review.
test("a deeply nested npm v1 lock enumerates instead of exhausting the stack", () => {
  let node = { version: "1.0.0" };
  for (let i = 0; i < 6000; i++) {
    node = { version: "1.0.0", dependencies: { [`p${i}`]: node } };
  }
  const addon = fakeAddon({
    "package-lock.json": JSON.stringify({
      lockfileVersion: 1,
      dependencies: { root: node },
    }),
  });
  assert.equal(lockedPackages(addon).length, 6001);
});

// Ordered by code point, not by locale: localeCompare puts these in a different
// order under a Swedish locale than under an English one, which would make the
// enumeration depend on the reviewing machine.
test("the order does not depend on the machine's locale", () => {
  const addon = fakeAddon({
    "package-lock.json": JSON.stringify({
      packages: {
        "node_modules/z-pkg": { version: "1.0.0" },
        "node_modules/ä-pkg": { version: "1.0.0" },
      },
    }),
  });
  assert.deepEqual(names(addon), ["z-pkg@1.0.0", "ä-pkg@1.0.0"]);
  // The same two under localeCompare, which is what must NOT be used.
  assert.deepEqual(
    ["z-pkg", "ä-pkg"].sort((a, b) => a.localeCompare(b)),
    ["ä-pkg", "z-pkg"]
  );
});

// One copy of a package being declared makes the package declared, the same way
// one production copy makes it shipped.
test("declared wins over reached when a package is installed twice", () => {
  const addon = fakeAddon({
    "package-lock.json": JSON.stringify({
      packages: {
        "node_modules/a/node_modules/dup": { version: "1.0.0" },
        "": { dependencies: { dup: "1.0.0" } },
        "node_modules/dup": { version: "1.0.0" },
      },
    }),
  });
  assert.deepEqual(declared(addon), ["dup"]);
});
