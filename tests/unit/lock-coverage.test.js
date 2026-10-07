// unreadableLock (src/vendor/locks.js): whether the committed lock can be read at all - the
// one lock question the review asks itself, because the dependency audit reads the installed
// tree out of the lock. Whether a readable lock matches package.json is the package
// manager's question (`npm ci`, `pnpm install --frozen-lockfile`), answered at the build,
// so a lock that disagrees with package.json is NOT reported here. The rule that turns the
// answer into a finding is tested in rules.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import { unreadableLock } from "../../src/vendor/locks.js";

function fakeAddon(files) {
  const map = new Map();
  for (const [k, v] of Object.entries(files)) {
    map.set(k, Buffer.from(typeof v === "string" ? v : JSON.stringify(v)));
  }
  return { files: map };
}

const declaring = { dependencies: { ms: "^2.1.3" } };

test("a lock that does not parse is unreadable, whatever the package.json declares", () => {
  for (const pkg of [declaring, {}]) {
    assert.deepEqual(
      unreadableLock(
        fakeAddon({
          "package.json": pkg,
          "package-lock.json": '{"packages": {',
        })
      ),
      { file: "package-lock.json", reason: "unreadable" }
    );
  }
});

// `npm ci` accepts a `{}` lock for a package file that declares nothing, so a lock of no
// recognisable shape is only a fault when something has to be installed from it.
test("a lock of no recognisable shape is reported only when something is declared", () => {
  assert.deepEqual(
    unreadableLock(
      fakeAddon({ "package.json": declaring, "package-lock.json": {} })
    ),
    { file: "package-lock.json", reason: "unrecognised" }
  );
  assert.equal(
    unreadableLock(fakeAddon({ "package.json": {}, "package-lock.json": {} })),
    null
  );
  assert.deepEqual(
    unreadableLock(
      fakeAddon({ "package.json": declaring, "pnpm-lock.yaml": "just: text\n" })
    ),
    { file: "pnpm-lock.yaml", reason: "unrecognised" }
  );
});

// A readable lock is not judged against package.json: a stale one, and a pnpm lock whose
// specifier follows an override, are the package manager's to accept or refuse.
test("a readable lock that disagrees with package.json is not this check's question", () => {
  const stale = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { ms: "^1.0.0" } },
      "node_modules/ms": { version: "1.0.0" },
    },
  };
  assert.equal(
    unreadableLock(
      fakeAddon({ "package.json": declaring, "package-lock.json": stale })
    ),
    null
  );
  const overridden = [
    "lockfileVersion: '9.0'",
    "overrides:",
    "  ms@<2.1.3: ^2.1.3",
    "importers:",
    "  .:",
    "    dependencies:",
    "      ms:",
    "        specifier: ^2.1.3",
    "        version: 2.1.3",
    "",
  ].join("\n");
  assert.equal(
    unreadableLock(
      fakeAddon({
        "package.json": { dependencies: { ms: "2.0.0" } },
        "pnpm-lock.yaml": overridden,
      })
    ),
    null
  );
});

test("no lock at all is sca-lock-file-missing's question, not this one", () => {
  assert.equal(unreadableLock(fakeAddon({ "package.json": declaring })), null);
});

// The governing lock is the one judged: npm installs from npm-shrinkwrap.json and never
// opens package-lock.json beside it.
test("the governing lock is the one that must be readable", () => {
  const good = {
    lockfileVersion: 3,
    packages: { "": declaring, "node_modules/ms": { version: "2.1.3" } },
  };
  assert.deepEqual(
    unreadableLock(
      fakeAddon({
        "package.json": declaring,
        "npm-shrinkwrap.json": "{",
        "package-lock.json": good,
      })
    ),
    { file: "npm-shrinkwrap.json", reason: "unreadable" }
  );
  assert.equal(
    unreadableLock(
      fakeAddon({
        "package.json": declaring,
        "npm-shrinkwrap.json": good,
        "package-lock.json": "{",
      })
    ),
    null
  );
});
