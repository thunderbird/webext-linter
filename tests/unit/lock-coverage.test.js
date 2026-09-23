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

import { lockGaps, lockedVersion } from "../../src/vendor/locks.js";

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

// npm's own question: does the version the lock PINS satisfy the range the manifest
// declares. Comparing the two SPECS instead answers a different question and gets it wrong
// both ways - measured against real npm, an exact "6.0.0" against a recorded ">=2.0.0" is
// "added 2 packages" while the strings differ, and a declared "^3.0.0" against a recorded
// ">=2.0.0" is two OVERLAPPING ranges while npm refuses the 6.0.0 the lock pinned.
test("npm v3: a pinned version outside the declared range is unsatisfied", () => {
  const gaps = (declared, root, version) =>
    gapsOf(
      fakeAddon({
        "package.json": { dependencies: { "web-ext": declared } },
        "package-lock.json": npm3(
          { dependencies: { "web-ext": root } },
          { "node_modules/web-ext": { version } }
        ),
      })
    );
  // 7.9.0 cannot satisfy ^8.0.0, whatever the root record restates.
  assert.deepEqual(gaps("^8.0.0", "^7.0.0", "7.9.0"), [
    "web-ext:unsatisfied:^7.0.0",
  ]);
  // The specs differ and the pin satisfies anyway: npm installs it, so this is silent.
  // Tightening a range to exactly what the lock pins is the case that used to reject.
  assert.deepEqual(gaps("7.9.0", "^7.0.0", "7.9.0"), []);
  assert.deepEqual(gaps("^7.0.0", "7.9.0", "7.9.0"), []);
  assert.deepEqual(gaps(">=7.0.0", "^7.0.0", "7.9.0"), []);
  assert.deepEqual(gaps("*", "^7.0.0", "7.9.0"), []);
  // Caret on a 0.0.x release admits only that patch - the rule a hand-rolled comparison
  // gets wrong, and a form the review corpus actually contains.
  assert.deepEqual(gaps("^0.0.353", "^0.0.353", "0.0.353"), []);
  assert.deepEqual(gaps("^0.0.353", "^0.0.353", "0.0.354"), [
    "web-ext:unsatisfied:^0.0.353",
  ]);
  // A range this cannot read says nothing: silence, never a guess, on a halting check.
  assert.deepEqual(gaps("latest", "^7.0.0", "7.9.0"), []);
});

// npm resolves ONE node per name and lets a second declaration win. Measured: a manifest
// declaring `dependencies: is-odd ^3.0.1` beside `devDependencies: is-odd ^2.0.0` makes npm
// install 2.0.0 - satisfying only the second - and `npm ci` then accepts its own lock. So
// the pin has to answer the NAME, not each declaration in turn, or we reject a lock npm is
// happy with. Reported once, too: the answer is about the resolved node, and there is one.
test("npm v3: a package declared in two maps answers as one node", () => {
  const twice = (depSpec, devSpec, version) =>
    gapsOf(
      fakeAddon({
        "package.json": {
          dependencies: { "is-odd": depSpec },
          devDependencies: { "is-odd": devSpec },
        },
        "package-lock.json": npm3(
          {
            dependencies: { "is-odd": depSpec },
            devDependencies: { "is-odd": devSpec },
          },
          { "node_modules/is-odd": { version } }
        ),
      })
    );
  // Satisfies both.
  assert.deepEqual(twice("^3.0.1", "^3.0.0", "3.0.1"), []);
  // Satisfies only the devDependencies range - which is npm's own resolution, accepted.
  assert.deepEqual(twice("^3.0.1", "^2.0.0", "2.0.0"), []);
  // Satisfies neither: one gap, not two.
  assert.deepEqual(twice("^3.0.1", "^2.0.0", "1.0.0"), [
    "is-odd:unsatisfied:^3.0.1",
  ]);
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
  // A root record restating an older alias range says nothing on its own: the pin still
  // satisfies what the manifest asks for, so npm installs it and this is silent.
  const olderRoot = {
    devDependencies: { "@typescript/lib-dom": "npm:@types/web@^0.0.1" },
  };
  assert.deepEqual(
    gapsOf(
      fakeAddon({
        "package.json": declared,
        "package-lock.json": npm3(olderRoot, installed),
      })
    ),
    []
  );
  // The pin itself outside the declared TARGET range is the fault - and `^0.0.353` admits
  // only that patch, so 0.0.354 fails it. The gap quotes the lock's spelling, alias and
  // all, because that is the string a developer has to find.
  assert.deepEqual(
    gapsOf(
      fakeAddon({
        "package.json": declared,
        "package-lock.json": npm3(olderRoot, {
          "node_modules/@typescript/lib-dom": {
            name: "@types/web",
            version: "0.0.354",
          },
        }),
      })
    ),
    ["@typescript/lib-dom:unsatisfied:npm:@types/web@^0.0.1"]
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

// A lock that cannot be PARSED and one that is merely the wrong SHAPE part company, so the
// two file-level faults are not decided together. Measured against npm itself: `npm ci`
// refuses an unparseable lock whatever the manifest declares, and accepts a `{}` one ("up
// to date") until a single dependency is declared, at which point it refuses that too.
//
// Deciding both behind "is anything declared?" left the hole this pins: the missing-lock
// check sees the file by NAME and falls silent, so committing a corrupt lock beat
// committing none - a submission `npm ci` refuses, cleared by both checks.
test("an unparseable lock is a fault whatever the manifest declares", () => {
  const gaps = (pkg, lock) =>
    gapsOf(fakeAddon({ "package.json": pkg, "package-lock.json": lock }));
  const declares = { dependencies: { "is-odd": "^3.0.1" } };
  const localOnly = { dependencies: { mylib: "file:./mylib" } };
  const nothing = { name: "t" };

  // Unparseable: npm refuses in all three, so all three report.
  for (const [label, pkg] of [
    ["declares a registry dep", declares],
    ["declares only a file: spec", localOnly],
    ["declares nothing", nothing],
  ]) {
    assert.deepEqual(gaps(pkg, ""), ["null:unreadable"], label);
    assert.deepEqual(gaps(pkg, "{ not json"), ["null:unreadable"], label);
  }

  // The wrong shape is only a fault when something has to be installed from it: npm
  // accepts `{}` for a manifest declaring nothing, and refuses it once one dep appears.
  assert.deepEqual(gaps(declares, "{}"), ["null:unrecognised"]);
  assert.deepEqual(gaps(nothing, "{}"), []);
  assert.deepEqual(gaps(localOnly, "{}"), []);

  // And a real lock for a project with no dependencies stays silent - npm writes exactly
  // this and installs from it, so demanding an entry would reject its own output.
  assert.deepEqual(
    gaps(nothing, JSON.stringify({ lockfileVersion: 3, packages: { "": {} } })),
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

test("a READABLE lock that governs no declaration is not judged", () => {
  // A manifest that declares nothing to install. There is no comparison to make, so the
  // lock's shape cannot be a finding - npm accepts a `{}` lock for such a manifest. An
  // unparseable one is different and IS reported, whatever is declared: npm cannot open it
  // either. That split is pinned above.
  for (const text of ["[1,2,3]", "{}"]) {
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

// ---- lockGaps and lockedVersion cannot disagree about one declaration ------------------
// If this check says the lock covers a declaration, resolveVendor must be able to pin it.
// One direction only: a `stale` gap still resolves a version, so the converse is not a rule.
//
// The direction that matters is the silent one. A declaration this check passes but
// lockedVersion cannot pin lands in `vendor.unpinned`, whose only reader is
// xpi-package-unpinned - and that check is `sca: false`, while lockedVersion is only ever
// called in an SCA review. So such a dependency is reported by nobody, and never reaches
// the OSV audit, the blocklist or the popularity gate either, because it never enters
// `packages`. Nothing about the report would look wrong.
test("a declaration this check passes is one lockedVersion can pin", () => {
  const npmV3 = (installed) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: { lodash: "^4.17.0" } }, ...installed },
    });
  const shapes = [
    [
      "npm v3, resolved",
      npmV3({ "node_modules/lodash": { version: "4.17.21" } }),
    ],
    [
      "npm v3, entry without a version",
      npmV3({ "node_modules/lodash": { resolved: "https://x" } }),
    ],
    ["npm v3, no installed entry", npmV3({})],
    [
      "npm v1, resolved",
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: { lodash: { version: "4.17.21" } },
      }),
    ],
    [
      "npm v1, entry without a version",
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: { lodash: { resolved: "https://x" } },
      }),
    ],
    [
      "npm v1, absent",
      JSON.stringify({ lockfileVersion: 1, dependencies: {} }),
    ],
    ["unreadable", "{ not json"],
    ["unrecognised", "{}"],
  ];
  for (const [label, lock] of shapes) {
    const addon = fakeAddon({
      "package.json": { dependencies: { lodash: "^4.17.0" } },
      "package-lock.json": lock,
    });
    const covered = !lockGaps(addon).some(
      (g) => g.name === "lodash" || g.name === null
    );
    if (covered) {
      assert.ok(
        lockedVersion(addon, "lodash"),
        `${label}: reported no gap, so it must pin a version`
      );
    }
  }
});
