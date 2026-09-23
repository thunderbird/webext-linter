// lockGaps (src/vendor/locks.js): whether the committed lock can install what the root
// package.json declares - the comparison `npm ci` and `pnpm install --frozen-lockfile`
// refuse over, and what the sca-lock-file-invalid check reports.
//
// Per FORMAT, because a golden fixture cannot be: a submission has ONE governing lock, so
// npm lockfileVersion 1, npm 2/3 and each pnpm shape need a case of their own. The rule
// that turns a gap into a finding is tested in rules.test.js; which lock GOVERNS, and the
// BOM, are tested in vendor-locks.test.js beside the readers they share.

import { test } from "node:test";
import assert from "node:assert/strict";

import { lockGaps } from "../../src/vendor/locks.js";
import { buildFileFault } from "../../src/build/reproducible.js";
import scaPackageFileMissing from "../../src/checks/rules/sca-package-file-missing.js";
import scaPackageFileInvalid from "../../src/checks/rules/sca-package-file-invalid.js";
import scaLockFileMissing from "../../src/checks/rules/sca-lock-file-missing.js";
import scaLockFileInvalid from "../../src/checks/rules/sca-lock-file-invalid.js";
import unsupportedBuildTool from "../../src/checks/rules/unsupported-build-tool.js";

function fakeAddon(files) {
  const map = new Map();
  for (const [k, v] of Object.entries(files)) {
    map.set(k, Buffer.from(typeof v === "string" ? v : JSON.stringify(v)));
  }
  return { files: map };
}

/** Each gap as "name:reason[:recorded]", which is what the finding renders from. */
const gapsOf = (addon) =>
  lockGaps(addon).map((g) =>
    g.recorded ? `${g.name}:${g.reason}:${g.recorded}` : `${g.name}:${g.reason}`
  );

/** An npm lockfileVersion 3 lock: a restated root manifest plus installed entries. */
const npm3 = (root, installed = {}) => ({
  lockfileVersion: 3,
  packages: { "": root, ...installed },
});

// ---- npm lockfileVersion 2/3 ----------------------------------------------------------
// `packages[""]` restates the root manifest, and that restatement is what `npm ci`
// compares package.json against.

test("npm v3: a declared package the root record omits is absent", () => {
  const addon = fakeAddon({
    "package.json": {
      devDependencies: { typescript: "^5.6.0", "web-ext": "^8.0.0" },
    },
    "package-lock.json": npm3(
      { devDependencies: { typescript: "^5.6.0" } },
      { "node_modules/typescript": { version: "5.6.3" } }
    ),
  });
  // Only the omitted one: typescript is covered and must stay silent.
  assert.deepEqual(gapsOf(addon), ["web-ext:absent"]);
});

test("npm v3: a spec the lock records differently is stale", () => {
  const addon = fakeAddon({
    "package.json": { dependencies: { "web-ext": "^8.0.0" } },
    "package-lock.json": npm3(
      { dependencies: { "web-ext": "^7.0.0" } },
      { "node_modules/web-ext": { version: "7.9.0" } }
    ),
  });
  assert.deepEqual(gapsOf(addon), ["web-ext:stale:^7.0.0"]);
});

test("npm v3: a root record entry that resolved to nothing is absent", () => {
  const addon = fakeAddon({
    "package.json": { dependencies: { "web-ext": "^8.0.0" } },
    // The manifest is restated faithfully, but nothing was installed for it.
    "package-lock.json": npm3({ dependencies: { "web-ext": "^8.0.0" } }),
  });
  assert.deepEqual(gapsOf(addon), ["web-ext:absent"]);
});

test("npm v3: a lock that covers the manifest yields no gap", () => {
  const addon = fakeAddon({
    "package.json": {
      dependencies: { "web-ext": "^8.0.0" },
      devDependencies: { typescript: "5.6.3" },
    },
    "package-lock.json": npm3(
      {
        dependencies: { "web-ext": "^8.0.0" },
        devDependencies: { typescript: "5.6.3" },
      },
      {
        "node_modules/web-ext": { version: "8.10.0" },
        "node_modules/typescript": { version: "5.6.3" },
      }
    ),
  });
  assert.deepEqual(gapsOf(addon), []);
});

// ---- npm lockfileVersion 1 -------------------------------------------------------------
// v1's top level is the hoisted tree, not a restated manifest, so there is nothing to
// compare a spec against - only whether the name is there at all.

test("npm v1 checks presence only, and never guesses stale", () => {
  const present = fakeAddon({
    "package.json": { dependencies: { jszip: "^3.10.0" } },
    // A version that does NOT satisfy the range: v1 must still not call it stale,
    // because it records no spec to have disagreed with.
    "package-lock.json": {
      lockfileVersion: 1,
      dependencies: { jszip: { version: "2.0.0" } },
    },
  });
  assert.deepEqual(gapsOf(present), []);

  const missing = fakeAddon({
    "package.json": { dependencies: { jszip: "^3.10.0" } },
    "package-lock.json": {
      lockfileVersion: 1,
      dependencies: { other: { version: "1.0.0" } },
    },
  });
  assert.deepEqual(gapsOf(missing), ["jszip:absent"]);
});

// ---- pnpm --------------------------------------------------------------------------------
// The importers ARE the manifests restated. v6+ carries each specifier on the entry; v5
// keeps a `specifiers` map, per importer when the lock has importers and at the top level
// when it does not.

test("pnpm v6+ carries the specifier on the entry", () => {
  const lock = (spec) =>
    `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      app-lib:\n        specifier: ${spec}\n        version: 2.0.0\n`;

  assert.deepEqual(
    gapsOf(
      fakeAddon({
        "package.json": { dependencies: { "app-lib": "^2.0.0" } },
        "pnpm-lock.yaml": lock("^2.0.0"),
      })
    ),
    []
  );
  assert.deepEqual(
    gapsOf(
      fakeAddon({
        "package.json": { dependencies: { "app-lib": "^2.0.0" } },
        "pnpm-lock.yaml": lock("^1.0.0"),
      })
    ),
    ["app-lib:stale:^1.0.0"]
  );
  // A name no importer map mentions.
  assert.deepEqual(
    gapsOf(
      fakeAddon({
        "package.json": {
          dependencies: { "app-lib": "^2.0.0", other: "^1.0.0" },
        },
        "pnpm-lock.yaml": lock("^2.0.0"),
      })
    ),
    ["other:absent"]
  );
});

test("pnpm v5 records specifiers per importer as well as at the top level", () => {
  const perImporter = fakeAddon({
    "package.json": { dependencies: { "web-ext": "^8.0.0" } },
    "pnpm-lock.yaml":
      "lockfileVersion: 5.4\nimporters:\n  .:\n    specifiers:\n      web-ext: ^7.0.0\n" +
      "    dependencies:\n      web-ext: 7.9.0\n",
  });
  assert.deepEqual(gapsOf(perImporter), ["web-ext:stale:^7.0.0"]);

  const topLevel = fakeAddon({
    "package.json": { dependencies: { "web-ext": "^8.0.0" } },
    "pnpm-lock.yaml":
      "lockfileVersion: 5.4\nspecifiers:\n  web-ext: ^7.0.0\ndependencies:\n  web-ext: 7.9.0\n",
  });
  assert.deepEqual(gapsOf(topLevel), ["web-ext:stale:^7.0.0"]);
});

// ---- across the formats ------------------------------------------------------------------

test("a lock that cannot be parsed is unreadable, not a pile of absences", () => {
  for (const [file, text] of [
    ["package-lock.json", "{not json"],
    ["pnpm-lock.yaml", "x: ["],
  ]) {
    const addon = fakeAddon({
      "package.json": { dependencies: { lodash: "^4.17.0" } },
      [file]: text,
    });
    const gaps = lockGaps(addon);
    assert.deepEqual(
      gaps.map((g) => `${g.file}:${g.reason}`),
      [`${file}:unreadable`],
      file
    );
    // The lock itself is the subject, so it anchors there and names no package.
    assert.equal(gaps[0].name, null, file);
  }
});

test("every declaration map the reviewer installs is compared", () => {
  const addon = fakeAddon({
    "package.json": {
      dependencies: { prod: "^1.0.0" },
      devDependencies: { dev: "^1.0.0" },
      optionalDependencies: { opt: "^1.0.0" },
      // Supplied by the host, not this build - never compared.
      peerDependencies: { peer: "^1.0.0" },
    },
    "package-lock.json": npm3({}),
  });
  assert.deepEqual(gapsOf(addon), ["prod:absent", "dev:absent", "opt:absent"]);
});

test("non-registry specs are left to the source-trust axis", () => {
  const addon = fakeAddon({
    "package.json": {
      dependencies: {
        local: "file:./pkg",
        linked: "link:../pkg",
        ws: "workspace:*",
        gh: "github:owner/repo",
        tarball: "https://example.test/x.tgz",
      },
    },
    "package-lock.json": npm3({}),
  });
  assert.deepEqual(gapsOf(addon), []);
});

// An `npm:<name>@<range>` alias is a registry install under another name, and both formats
// record it like any other declaration: keyed by the name it is WRITTEN under, spec stored
// verbatim. So it is compared like any other, and the two package managers refuse over a
// missing or stale one exactly as they do for the rest. Skipping it would leave an install
// `npm ci` rejects looking perfectly covered.
test("npm v3: an aliased declaration is compared like any other", () => {
  const ALIAS = "npm:@types/web@^0.0.353";
  const declared = { devDependencies: { "@typescript/lib-dom": ALIAS } };
  const installed = {
    "node_modules/@typescript/lib-dom": {
      name: "@types/web",
      version: "0.0.353",
    },
  };

  // Recorded faithfully: nothing to report.
  assert.deepEqual(
    gapsOf(
      fakeAddon({
        "package.json": declared,
        "package-lock.json": npm3(declared, installed),
      })
    ),
    []
  );
  // Left out of the root record entirely.
  assert.deepEqual(
    gapsOf(
      fakeAddon({
        "package.json": declared,
        "package-lock.json": npm3({}, installed),
      })
    ),
    ["@typescript/lib-dom:absent"]
  );
  // Recorded, but against a range the manifest no longer asks for. The gap quotes the
  // lock's spelling, alias and all, because that is the string a developer has to find.
  assert.deepEqual(
    gapsOf(
      fakeAddon({
        "package.json": declared,
        "package-lock.json": npm3(
          {
            devDependencies: { "@typescript/lib-dom": "npm:@types/web@^0.0.1" },
          },
          installed
        ),
      })
    ),
    ["@typescript/lib-dom:stale:npm:@types/web@^0.0.1"]
  );
  // The root record names it but nothing was installed for it.
  assert.deepEqual(
    gapsOf(
      fakeAddon({
        "package.json": declared,
        "package-lock.json": npm3(declared, {}),
      })
    ),
    ["@typescript/lib-dom:absent"]
  );
});

// pnpm keys its importer entry the same way, carrying the written spec as `specifier`.
test("pnpm: an aliased declaration is compared by its specifier", () => {
  const lock = (specifier) =>
    `importers:\n  .:\n    devDependencies:\n      '@typescript/lib-dom':\n        specifier: ${specifier}\n        version: '@types/web@0.0.353'\n`;
  const declared = {
    devDependencies: { "@typescript/lib-dom": "npm:@types/web@^0.0.353" },
  };
  assert.deepEqual(
    gapsOf(
      fakeAddon({
        "package.json": declared,
        "pnpm-lock.yaml": lock("npm:@types/web@^0.0.353"),
      })
    ),
    []
  );
  assert.deepEqual(
    gapsOf(
      fakeAddon({
        "package.json": declared,
        "pnpm-lock.yaml": lock("npm:@types/web@^0.0.1"),
      })
    ),
    ["@typescript/lib-dom:stale:npm:@types/web@^0.0.1"]
  );
});

// npm reads the lock it PREFERS and fails on it - it does not fall back to another sitting
// beside it. Measured against npm itself: the same tree installs cleanly from a valid
// package-lock.json alone, and is refused (EUSAGE) once an unparseable npm-shrinkwrap.json
// is added next to it. Stepping over the broken one would clear a submission npm refuses.
test("a present-but-unreadable lock stops there, with a valid one beside it", () => {
  const declared = { dependencies: { lodash: "^4.17.0" } };
  const good = npm3(declared, {
    "node_modules/lodash": { version: "4.17.21" },
  });
  assert.deepEqual(
    gapsOf(
      fakeAddon({
        "package.json": declared,
        "npm-shrinkwrap.json": "{not json",
        "package-lock.json": good,
      })
    ),
    ["null:unreadable"]
  );
  // The shrinkwrap governs when it DOES parse, so a good pair reports nothing.
  assert.deepEqual(
    gapsOf(
      fakeAddon({
        "package.json": declared,
        "npm-shrinkwrap.json": good,
        "package-lock.json": good,
      })
    ),
    []
  );
});

test("no lock at all is sca-lock-file-missing's question, not this one", () => {
  const addon = fakeAddon({
    "package.json": { dependencies: { lodash: "^4.17.0" } },
  });
  assert.deepEqual(lockGaps(addon), []);
});

// ---- the manifest is untrusted input ------------------------------------------------------
// None of these shapes may become a finding about a package the developer never named,
// and none may hide a real gap.

test("lockGaps hardens the manifest it reads", () => {
  // `constructor` and `toString` ARE real npm packages. Read off the prototype chain they
  // resolve to Object.prototype's members, which reported the lock as recording
  // "function Object() { [native code] }".
  const proto = fakeAddon({
    "package.json": {
      dependencies: {
        constructor: "^0.0.6",
        toString: "^1.0.0",
        lodash: "^4.0.0",
      },
    },
    "package-lock.json": npm3(
      { dependencies: { lodash: "^4.0.0" } },
      { "node_modules/lodash": { version: "4.17.21" } }
    ),
  });
  assert.deepEqual(gapsOf(proto), ["constructor:absent", "toString:absent"]);

  // npm records a spec verbatim, so " ^2.1.3 " and "^2.1.3" are the same install - and
  // the report renders both identically, so reporting it is unactionable as well as wrong.
  const spaced = fakeAddon({
    "package.json": { dependencies: { ms: " ^2.1.3 " } },
    "package-lock.json": npm3(
      { dependencies: { ms: "^2.1.3" } },
      { "node_modules/ms": { version: "2.1.3" } }
    ),
  });
  assert.deepEqual(gapsOf(spaced), []);

  // A map that is not an object, and a spec that is not a string: npm rejects both, so
  // there is no install to reason about. Walking them yielded findings named "0 (l)".
  for (const deps of ['"lodash"', '["lodash"]', '{"a": 1, "b": null}']) {
    const odd = fakeAddon({
      "package.json": `{"dependencies": ${deps}}`,
      "package-lock.json": npm3({}),
    });
    assert.deepEqual(lockGaps(odd), [], `dependencies: ${deps}`);
  }

  // A manifest that is not a JSON object at all states nothing to cover.
  for (const text of ["[1,2,3]", '"nope"', "null", "{not json"]) {
    const bad = fakeAddon({
      "package.json": text,
      "package-lock.json": npm3({}),
    });
    assert.deepEqual(lockGaps(bad), [], text);
  }
});

// ---- a lock we cannot interpret ----------------------------------------------------------
// The loudest possible wrong answer is to judge through a file nothing understood: every
// declared package comes back "not recorded" and the submission is rejected on the strength
// of it. Each of these is reported as the FILE instead.

test("a lock whose shape is not recognisable is reported as itself", () => {
  const pkg = { dependencies: { ms: "^2.1.3", lodash: "^4.17.0" } };
  const cases = [
    // Parses, but is not an object at all.
    ["package-lock.json", "[1,2,3]"],
    ['package-lock.json ("x")', '"x"'],
    // An npm lock whose root record - the restated manifest npm ci compares against - is
    // not there, so there is nothing to compare with.
    [
      "package-lock.json (no root record)",
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/ms": { version: "2.1.3" } },
      }),
    ],
    // A pnpm lock with importers but no root one.
    [
      "pnpm-lock.yaml (no '.' importer)",
      "lockfileVersion: '9.0'\nimporters:\n  pkgs/a:\n    dependencies:\n      ms:\n        specifier: ^2.1.3\n        version: 2.1.3\n",
    ],
    // Valid YAML that is simply not a lock file.
    ["pnpm-lock.yaml (not a lock)", "title: notes\nauthor: someone\n"],
  ];
  for (const [label, text] of cases) {
    const file = label.split(" ")[0];
    const gaps = lockGaps(fakeAddon({ "package.json": pkg, [file]: text }));
    assert.deepEqual(
      gaps.map((g) => `${g.file}:${g.reason}`),
      [`${file}:unrecognised`],
      label
    );
    // The file is the subject, so no package is named and nothing is blamed on one.
    assert.equal(gaps[0].name, null, label);
  }
});

test("a lock that governs no declaration is not judged at all", () => {
  // Every shape above, against a manifest that declares nothing to install. There is no
  // comparison to make, so the lock's state cannot be a finding.
  for (const text of ["[1,2,3]", "{}", "{not json"]) {
    assert.deepEqual(
      lockGaps(
        fakeAddon({
          "package.json": { scripts: { build: "x" } },
          "package-lock.json": text,
        })
      ),
      [],
      text
    );
  }
  // Nor when the only declarations are ones this comparison never reads.
  assert.deepEqual(
    lockGaps(
      fakeAddon({
        "package.json": { dependencies: { local: "file:./pkg" } },
        "package-lock.json": "[1,2,3]",
      })
    ),
    []
  );
});

// npm compares the two manifests by NAME: moving a package between dependencies and
// devDependencies without regenerating is an install `npm ci` accepts. pnpm is stricter,
// and its reader keys by map, which is why only the npm side looks across the union.
test("npm accepts a dependency moved between the declaration maps", () => {
  const lock = (map) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { [map]: { ms: "^2.1.3" } },
        "node_modules/ms": { version: "2.1.3" },
      },
    });
  for (const [declaredIn, recordedIn] of [
    ["dependencies", "devDependencies"],
    ["devDependencies", "dependencies"],
  ]) {
    assert.deepEqual(
      gapsOf(
        fakeAddon({
          "package.json": { [declaredIn]: { ms: "^2.1.3" } },
          "package-lock.json": lock(recordedIn),
        })
      ),
      [],
      `${declaredIn} -> ${recordedIn}`
    );
  }
  // A name in neither map is still absent.
  assert.deepEqual(
    gapsOf(
      fakeAddon({
        "package.json": { dependencies: { ms: "^2.1.3" } },
        "package-lock.json": lock2(),
      })
    ),
    ["ms:absent"]
  );
});

function lock2() {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: { "": { dependencies: { other: "^1.0.0" } } },
  });
}

// ---- buildFileFault agrees with the checks it composes -------------------------------
// The XPI-only advice is withheld exactly when one of the five build checks rejects
// (src/build/reproducible.js): the package manager, then the manifest, then the lock. Two
// statements of one rule can drift - this asserts they have not: a fault is reported if
// and ONLY if some check speaks. Without it, a condition
// changed in a check but not in the composite silently brings back the contradiction the
// composite exists to prevent: "your archive was unnecessary", printed beside a rejection.
test("buildFileFault is non-null exactly when a build-file check reports", () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {} } });
  const covering = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { lodash: "^4.17.0" } },
      "node_modules/lodash": { version: "4.17.21" },
    },
  });
  const deps = JSON.stringify({ dependencies: { lodash: "^4.17.0" } });
  const shapes = [
    { "manifest.json": "{}" },
    { "package.json": "{}" },
    { "package.json": "{}", "package-lock.json": lock },
    { "package.json": "{not json" },
    { "package.json": "{not json", "package-lock.json": lock },
    { "package.json": "[]", "package-lock.json": lock },
    { "package.json": deps },
    { "package.json": deps, "package-lock.json": covering },
    { "package.json": deps, "package-lock.json": lock },
    { "package.json": deps, "package-lock.json": "{not json" },
    { "package.json": "{}", "yarn.lock": "" },
    { "package.json": JSON.stringify({ workspaces: ["packages/*"] }) },
  ];
  for (const files of shapes) {
    const addon = fakeAddon(files);
    const ctx = { addon, note: () => {} };
    const reports = [
      unsupportedBuildTool,
      scaPackageFileMissing,
      scaPackageFileInvalid,
      scaLockFileMissing,
      scaLockFileInvalid,
    ].some((rule) => rule.run(ctx).findings.length > 0);
    const fault = buildFileFault(addon);
    assert.equal(
      Boolean(fault),
      reports,
      `${JSON.stringify(Object.keys(files))} -> fault ${fault}, checks report ${reports}`
    );
  }
});
