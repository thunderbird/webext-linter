// Unit tests for resolveVendor: the deterministic VENDOR parse, the package.json
// dependency classification, and verifiedVendorSource / declaredFiles. Offline by
// construction - resolveVendor reads only the submission.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveVendor,
  verifiedVendorSource,
  declaredFiles,
} from "../../src/vendor/resolve.js";

// The loader records every directory it walks into, so a fake addon has to carry the same
// fact - derived here from the keys, which is what a real walk of exactly these files would
// have recorded. A directory a Map cannot express (an empty one) is passed explicitly.
function impliedDirectories(keys) {
  const dirs = new Set();
  for (const key of keys) {
    const segs = key.split("/");
    for (let i = 1; i < segs.length; i += 1) {
      dirs.add(segs.slice(0, i).join("/"));
    }
  }
  return [...dirs];
}

function fakeAddon(files, extraDirs = []) {
  const map = new Map();
  for (const [k, v] of Object.entries(files)) {
    map.set(k, Buffer.from(v));
  }
  return {
    files: map,
    directories: [...impliedDirectories(map.keys()), ...extraDirs],
  };
}

// A VENDOR file in prose declares nothing: the parse is deterministic, so an entry it
// cannot map yields an empty entry list and an empty skip set rather than a guess.
test("resolveVendor maps nothing from a VENDOR file that declares nothing", async () => {
  const addon = fakeAddon({
    VENDOR: "We bundle the Foo library; see our docs for details.",
    "app.js": "x",
  });
  const { set, entries } = await resolveVendor({ addon });
  assert.equal(entries.length, 0);
  assert.equal(set.size, 0);
});

// The accepted format: "File:" / "Source:" pairs, one declaration each. The declared
// file is library-like (.min), as the format requires.
test("resolveVendor maps a declared file to its source", async () => {
  const addon = fakeAddon({
    "VENDOR.md":
      "File: vendor/jszip.min.js\nSource: https://unpkg.com/jszip@3.10.1/dist/jszip.min.js\n",
    "vendor/jszip.min.js": "x",
  });
  const { entries } = await resolveVendor({ addon });
  assert.deepEqual(
    entries.map((e) => [e.path, e.sourceUrl]),
    [
      [
        "vendor/jszip.min.js",
        "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js",
      ],
    ]
  );
});

// A VENDOR entry (file + URL) naming an absent file is surfaced as `missing`, and
// is NOT treated as "unparsed" (so it routes to missing-vendor-file, not manual).
test("resolveVendor surfaces a missing declared file, not 'unparsed'", async () => {
  const addon = fakeAddon({
    VENDOR: "File: lib/ghost.js\nSource: https://unpkg.com/x@1.0.0/ghost.js\n",
    "bg.js": "x",
  });
  const { entries, missing, unparsedVendor } = await resolveVendor({
    addon,
    token: undefined,
  });
  assert.equal(entries.length, 0);
  assert.deepEqual(
    missing.map((e) => e.path),
    ["lib/ghost.js"]
  );
  assert.equal(unparsedVendor, false);
});

// A VENDOR file we could extract nothing from (pure prose) is still "unparsed".
test("resolveVendor marks a pure-prose VENDOR as 'unparsed'", async () => {
  const addon = fakeAddon({
    VENDOR: "We bundle some stuff, see our docs.",
    "bg.js": "x",
  });
  const { entries, missing, unparsedVendor } = await resolveVendor({
    addon,
    token: undefined,
  });
  assert.equal(entries.length, 0);
  assert.equal(missing.length, 0);
  assert.equal(unparsedVendor, true);
});

const LIB = "/*! Lib v1 | (c) authors | MIT */\n(function () {})();\n";

// A block that names a library file but only a bare repository URL (not a file
// source) has no valid entry -> "unparsed" (a parse-error finding, not silently
// dropped).
test("resolveVendor marks a library + repo-only-URL block as 'unparsed'", async () => {
  const addon = fakeAddon({
    "VENDOR.md":
      "## DOMPurify\n" +
      "- Included file: `vendor/purify.js`\n" +
      "- Upstream repository: https://github.com/cure53/DOMPurify\n",
    "vendor/purify.js": LIB,
  });
  const { entries, missing, unparsedVendor } = await resolveVendor({
    addon,
    token: undefined,
  });
  assert.equal(entries.length, 0);
  assert.equal(missing.length, 0);
  assert.equal(unparsedVendor, true);
});

// A packaged file paired with a source URL is trusted as a vendor entry even when
// it is the add-on's own (non-library) code - verification, not the parser, decides.
test("resolveVendor trusts a declared file + source URL", async () => {
  const addon = fakeAddon({
    "VENDOR.md":
      "File: modules/own.js\nSource: https://unpkg.com/x@1.0.0/own.js\n",
    "modules/own.js": "export function f() {}\n",
  });
  const { entries, unparsedVendor } = await resolveVendor({
    addon,
    token: undefined,
  });
  assert.deepEqual(
    entries.map((e) => [e.path, e.sourceUrl]),
    [["modules/own.js", "https://unpkg.com/x@1.0.0/own.js"]]
  );
  assert.equal(unparsedVendor, false);
});

// A directory declaration is checked against an ARCHIVE of the upstream release -
// a github /tree/ repo ZIP or a pinned npm package's tarball. A source that is
// neither is settled here, offline, and for a reason worth keeping: a raw file URL
// (or a CDN listing page) is FETCHABLE, so the request succeeds and only the unzip
// fails - which used to record every file under the directory as unfetchable, each
// reviewed as the developer's own code and each minified one rejected, over one
// wrong URL. Reported as an unusable pairing instead, with nothing fetched.
test("resolveVendor refuses a directory source that is not an archive", async () => {
  const RAW = "https://raw.githubusercontent.com/o/r/v1.0.0/dist/index.js";
  const addon = fakeAddon({
    "VENDOR.md": `- directory: vendor/lib\n- source: ${RAW}\n`,
    "vendor/lib/a.js": "x",
    "vendor/lib/b.js": "y",
  });
  const { entries, ambiguousSources, folders } = await resolveVendor({
    addon,
    token: undefined,
  });
  assert.deepEqual(entries, []); // never handed to the fetch
  assert.equal(ambiguousSources.length, 1);
  assert.equal(ambiguousSources[0].source, RAW);
  assert.deepEqual([...ambiguousSources[0].paths].sort(), [
    "vendor/lib/a.js",
    "vendor/lib/b.js",
  ]);
  assert.ok(folders.has("vendor/lib"), "the files stay vendored");
});

// The two shapes that CAN answer for a directory are left alone, so the guard does
// not quietly take the feature away while fixing how it fails.
test("resolveVendor keeps a directory source that is an archive", async () => {
  for (const source of [
    "https://github.com/o/r/tree/v1.0.0/dist",
    "https://cdn.jsdelivr.net/npm/widget@1.2.3/dist/",
  ]) {
    const addon = fakeAddon({
      "VENDOR.md": `- directory: vendor/lib\n- source: ${source}\n`,
      "vendor/lib/a.js": "x",
    });
    const { entries, ambiguousSources } = await resolveVendor({
      addon,
      token: undefined,
    });
    assert.deepEqual(ambiguousSources, [], source);
    assert.deepEqual(
      entries.map((e) => e.sourceUrl),
      [source],
      source
    );
  }
});

// A single source URL paired with more than one bundled FILE is ambiguous:
// resolveVendor pulls those out of the entry list (not verified) and records
// them on ambiguousSources, while keeping their paths vendored (skip-set).
test("resolveVendor flags >1 file per source URL as ambiguous", async () => {
  const addon = fakeAddon({
    // One block per file, both citing the same URL - the shape a developer writes
    // when one release covers several bundled files. Two file keys in ONE block is
    // a contradiction the parser refuses outright (tests/unit/vendor.test.js).
    "VENDOR.md":
      "## Bundle\n" +
      "- bundled file: vendor/a.min.js\n" +
      "- source: https://unpkg.com/bundle@1.0.0/dist/bundle.js\n" +
      "\n" +
      "- bundled file: vendor/b.min.js\n" +
      "- source: https://unpkg.com/bundle@1.0.0/dist/bundle.js\n",
    "vendor/a.min.js": "x",
    "vendor/b.min.js": "x",
  });
  const { entries, ambiguousSources, set } = await resolveVendor({
    addon,
    token: undefined,
  });
  assert.deepEqual(entries, []); // not verified - ambiguous pairing
  assert.equal(ambiguousSources.length, 1);
  assert.equal(
    ambiguousSources[0].source,
    "https://unpkg.com/bundle@1.0.0/dist/bundle.js"
  );
  assert.deepEqual([...ambiguousSources[0].paths].sort(), [
    "vendor/a.min.js",
    "vendor/b.min.js",
  ]);
  assert.deepEqual([...set].sort(), ["vendor/a.min.js", "vendor/b.min.js"]);
});

// A `bundled directory` + a github tree URL is a folder entry: its path goes to
// `folders` (prefix skip-set), not the exact-path `set`, and it is never ambiguous.
test("resolveVendor records a folder declaration", async () => {
  const TREE =
    "https://github.com/o/r/tree/0123456789012345678901234567890123456789/dist/lib";
  const addon = fakeAddon({
    "VENDOR.md": `- bundled directory : vendor/lib\n- source : ${TREE}\n`,
    "vendor/lib/a.js": "x",
  });
  const { entries, folders, set, ambiguousSources } = await resolveVendor({
    addon,
    token: undefined,
  });
  assert.deepEqual(
    entries.map((e) => [e.path, e.kind]),
    [["vendor/lib", "folder"]]
  );
  assert.deepEqual([...folders], ["vendor/lib"]);
  assert.deepEqual([...set], []); // a folder is a prefix, not an exact path
  assert.deepEqual(ambiguousSources, []);
});

// package.json dependencies are classified by spec into the only two supported
// sources - a pinned npm package and a GitHub URL - plus the two rejected cases:
// an unpinned range, and an unsupported source (file:/non-github git). An `npm:` alias
// is npm like any other: it is classified by the package it INSTALLS, so the name it is
// written under never decides whether its source can be verified.
// npm accepts one name in several maps with different specs, and defines a precedence for
// each pair - so a name cannot stand in for a declaration. A `file:` spec that resolves
// exempts ITS OWN declaration from unsupported-dependency and no other: otherwise one
// harmless line launders whatever else the package file declares under that name, and npm
// installs the laundered one, since the `dependencies` copy wins over `devDependencies`.
test("a resolved file: spec exempts its own declaration, not the name", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { evil: "https://attacker.example/evil.tgz" },
      devDependencies: { evil: "file:." },
    }),
    "bg.js": "1;\n",
  });
  const v = await resolveVendor({
    addon,
    reviewerInstalls: true,
    enabled: false,
  });
  assert.deepEqual(v.unsupportedDeps, [
    {
      name: "evil",
      spec: "https://attacker.example/evil.tgz",
      file: "package.json",
    },
  ]);
});

// The other direction, so the fix cannot be "exempt nothing": a file: spec that resolves is
// still dropped, in whichever map it was written - optionalDependencies included, which
// joined the build-time bucket alongside devDependencies.
test("a resolved file: spec is exempt in whichever map declares it", async () => {
  for (const map of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    const addon = fakeAddon({
      "package.json": JSON.stringify({ [map]: { helper: "file:." } }),
      "bg.js": "1;\n",
    });
    const v = await resolveVendor({
      addon,
      reviewerInstalls: true,
      enabled: false,
    });
    assert.deepEqual(v.unsupportedDeps, [], map);
  }
});

test("resolveVendor classifies package.json deps by source", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: {
        pinned: "1.2.3", // npm, exact
        ranged: "^2.0.0", // a range, and no lock committed to resolve it
        ghshort: "github:o/r#v1.0.0", // github
        ghbare: "owner/repo", // github bare shorthand
        ghurl: "git+https://github.com/a/b.git", // github url
        ghscp: "git@github.com:scp/repo.git#v3", // github SCP-style git URL
        local: "file:../x", // unsupported
        aliased: "npm:other@1.0.0", // npm, exact, installed under another name
        gitlab: "git+https://gitlab.com/o/r.git", // unsupported (non-github git)
      },
    }),
  });
  const v = await resolveVendor({ addon, enabled: false });
  assert.deepEqual(v.packages, [
    { name: "pinned", version: "1.2.3", file: "package.json" },
    // The alias enters as the package it installs, which is what OSV and npm know.
    { name: "other", version: "1.0.0", file: "package.json" },
  ]);
  assert.deepEqual(
    v.unlocked.map((u) => u.name),
    ["ranged"]
  );
  assert.deepEqual(v.unpinned, []);
  assert.deepEqual(
    v.githubDeps.map((g) => `${g.name}:${g.repo}`),
    ["ghshort:o/r", "ghbare:owner/repo", "ghurl:a/b", "ghscp:scp/repo"]
  );
  assert.equal(
    v.githubDeps.find((g) => g.name === "ghshort").ref,
    "v1.0.0" // the #ref is captured
  );
  assert.equal(v.githubDeps.find((g) => g.name === "ghscp").ref, "v3");
  assert.deepEqual(
    v.unsupportedDeps.map((u) => u.name),
    ["local", "gitlab"]
  );
  // "local" (file:../x) still rejects with reviewerInstalls: true - the SCA-only mode
  // this feature adds - because no "x" directory exists anywhere in the store for it to
  // resolve to. Never exercised before this test passed reviewerInstalls at all.
  const scaV = await resolveVendor({
    addon,
    reviewerInstalls: true,
    enabled: false,
  });
  assert.deepEqual(
    scaV.unsupportedDeps.map((u) => u.name),
    ["local", "gitlab"]
  );
});

// devDependencies never ship, but the SCA reviewer builds from source, so their
// pinned npm packages are OSV-audited too. Only the pinned-npm bucket lands in
// An optionalDependency is a build-time declaration, classified with the dev ones: npm
// installs it where the platform allows, so whoever installs from this package file runs it.
// It must not fall out of the classification altogether - the lock's own direct set spans
// every declaration map, so the whole-tree audit skips it as declared (alreadyAudited) and
// a declared audit is the only thing left that can receive it.
test("resolveVendor classifies an optionalDependency as build-time", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { prod: "1.0.0" },
      optionalDependencies: { "platform-binary": "2.3.3" },
    }),
  });
  const v = await resolveVendor({
    addon,
    reviewerInstalls: true,
    enabled: false,
  });
  assert.deepEqual(v.devPackages, [
    { name: "platform-binary", version: "2.3.3", file: "package.json" },
  ]);
  // Never as a shipped one: nothing vendors from it, so it is not held to a release.
  assert.deepEqual(v.packages, [
    { name: "prod", version: "1.0.0", file: "package.json" },
  ]);
});

// npm's package.json docs: "Entries in optionalDependencies will override entries of the
// same name in dependencies". The optional spec is therefore the one installed, so it is
// the one audited - and only it, so one package is classified once and the two vuln
// checks never both report it. Auditing the losing `dependencies` spec would hold the
// release to a version npm never resolves.
test("resolveVendor lets an optional entry win over a dependencies entry of the same name", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { both: "1.0.0" },
      optionalDependencies: { both: "2.0.0" },
    }),
  });
  const v = await resolveVendor({
    addon,
    reviewerInstalls: true,
    enabled: false,
  });
  assert.deepEqual(v.packages, []);
  assert.deepEqual(v.devPackages, [
    { name: "both", version: "2.0.0", file: "package.json" },
  ]);
});

// Both overrides at once: the optional entry beats the prod one, and having lost, that
// prod entry cannot go on to displace the dev copy either - the name is classified once,
// as the spec npm installs.
test("resolveVendor resolves a name declared in all three maps to the optional entry", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { all: "1.0.0" },
      devDependencies: { all: "3.0.0" },
      optionalDependencies: { all: "2.0.0" },
    }),
  });
  const v = await resolveVendor({
    addon,
    reviewerInstalls: true,
    enabled: false,
  });
  assert.deepEqual(v.packages, []);
  assert.deepEqual(v.devPackages, [
    { name: "all", version: "2.0.0", file: "package.json" },
  ]);
});

// devPackages: an exact spec, or - for a source archive, whose lock is what the reviewer
// installs from - a range that lock pins. A range with no lock, a github source, and an
// unsupported source are dropped, and never leak into the prod buckets.
test("resolveVendor collects pinned npm devDependencies in devPackages", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { prod: "1.0.0" },
      devDependencies: {
        esbuild: "0.19.0", // npm, exact -> devPackages
        webpack: "^5.0.0", // range, pinned by the lock -> devPackages
        ranged: "^2.0.0", // range, no lock -> dropped (nothing vendors from a dev dep)
        ghdev: "github:o/r#v1.0.0", // github -> kept: popularity-gated like a prod one
        localdev: "file:../x", // unsupported SOURCE -> kept: npm ci clones and runs it
      },
    }),
    "package-lock.json": JSON.stringify({
      packages: { "node_modules/webpack": { version: "5.88.0" } },
    }),
  });
  const v = await resolveVendor({
    addon,
    reviewerInstalls: true,
    enabled: false,
  });
  assert.deepEqual(v.devPackages, [
    { name: "esbuild", version: "0.19.0", file: "package.json" },
    { name: "webpack", version: "5.88.0", file: "package.json" },
  ]);
  // Prod deps are unaffected, and no dev dep leaks into the prod buckets.
  assert.deepEqual(v.packages, [
    { name: "prod", version: "1.0.0", file: "package.json" },
  ]);
  // WHO a dev dependency comes from is judged exactly as for a production one, because
  // the reviewer's install clones and RUNS it. Pinning is not: nothing vendors from a dev
  // dep, so no release is ever fetched to compare against.
  assert.deepEqual(
    v.unsupportedDeps.map((u) => u.name),
    ["localdev"]
  );
  assert.deepEqual(
    v.githubDeps.map((g) => g.name),
    ["ghdev"]
  );

  // In a built XPI nothing is installed and a dev entry vendors nothing, so the same
  // declarations are inert there and must not reject the submission.
  const shipped = await resolveVendor({ addon, enabled: false });
  assert.deepEqual(
    shipped.unsupportedDeps.map((u) => u.name),
    []
  );
  assert.deepEqual(
    shipped.githubDeps.map((g) => g.name),
    []
  );
});

// A package listed in BOTH dependencies and devDependencies (legal npm - the
// dependencies copy wins) is a production dependency: it is classified once as
// prod and dropped from devPackages, so it is audited + reported once (not by both
// vendor-vulnerable and vendor-vulnerable-dev at the same line).
test("resolveVendor treats a dep in both dependencies and devDependencies as prod-only", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { shared: "1.0.0", prodonly: "2.0.0" },
      devDependencies: { shared: "1.0.0", devonly: "3.0.0" },
    }),
  });
  const v = await resolveVendor({ addon, enabled: false });
  assert.deepEqual(v.packages, [
    { name: "shared", version: "1.0.0", file: "package.json" },
    { name: "prodonly", version: "2.0.0", file: "package.json" },
  ]);
  // "shared" is NOT in devPackages - only the genuinely dev-only package is.
  assert.deepEqual(v.devPackages, [
    { name: "devonly", version: "3.0.0", file: "package.json" },
  ]);
});

// ---- file:/link: local packages (SCA mode only) ----
// A file:/link: spec that resolves to a real directory inside the submission is authored
// code, not a dependency: it never reaches unsupportedDeps. Its OWN declared dependencies
// (both dependencies and devDependencies - npm installs a locally-linked package's
// devDependencies unconditionally) are real external sources and classified exactly like
// the root's, tagged with the nested package file's own path.
test("resolveVendor recurses into a file:-linked local package's own dependencies", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { "@scope/helper": "file:./helper" },
    }),
    "helper/package.json": JSON.stringify({
      dependencies: { pinned: "1.0.0" },
      devDependencies: { ranged: "^2.0.0" },
    }),
    "helper/index.js": "export {};\n",
    "package-lock.json": JSON.stringify({
      packages: { "node_modules/ranged": { version: "2.5.0" } },
    }),
  });
  const v = await resolveVendor({
    addon,
    reviewerInstalls: true,
    enabled: false,
  });
  // The file: entry itself names authored code - dropped entirely, not "unsupported".
  assert.deepEqual(v.unsupportedDeps, []);
  assert.deepEqual(v.packages, [
    { name: "pinned", version: "1.0.0", file: "helper/package.json" },
  ]);
  assert.deepEqual(v.devPackages, [
    { name: "ranged", version: "2.5.0", file: "helper/package.json" },
  ]);
});

// A file: target that resolves to a real directory but one with no readable package.json
// is still authored code (the bytes are right there) - dropped from unsupported, with
// nothing further to classify, rather than rejected for lacking a package file.
test("resolveVendor treats a file: target with no package file as authored code, nothing further", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { assets: "file:./assets" },
    }),
    "assets/logo.png": "not-really-a-png",
  });
  const v = await resolveVendor({
    addon,
    reviewerInstalls: true,
    enabled: false,
  });
  assert.deepEqual(v.unsupportedDeps, []);
  assert.deepEqual(v.packages, []);
  assert.deepEqual(v.devPackages, []);
});

// A file: chain that loops back on itself (a nested package file referencing an ancestor
// directory, including the root) is not an error: that directory genuinely is part of the
// submission. It is accepted like any other resolving local target - dropped from
// unsupported - but not re-walked, which is what keeps the recursion from looping forever.
test("resolveVendor accepts a file: cycle without recursing forever", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { nested: "file:./nested" },
    }),
    "nested/package.json": JSON.stringify({
      dependencies: { back: "file:.." }, // points back at the submission root
    }),
  });
  const v = await resolveVendor({
    addon,
    reviewerInstalls: true,
    enabled: false,
  });
  // Neither "nested" (root -> nested) nor "back" (nested -> root) is a dependency needing
  // verification - both name real, already-known directories.
  assert.deepEqual(v.unsupportedDeps, []);
  assert.deepEqual(v.packages, []);
});

// The end of the chain for a spec that names a FILE rather than a directory: it reaches
// unsupported-dependency, where a source the reviewer cannot identify belongs. A local
// tarball is the case with teeth - npm installs from it, and it is bytes this review never
// unpacks - and it used to be dropped here, because a file key matched the directory test
// exactly.
test("resolveVendor reports a file: spec naming a tarball as an unsupported source", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { payload: "file:./libs/payload.tgz", ok: "file:./helper" },
    }),
    "libs/payload.tgz": "\u001f\u008b binary",
    "helper/package.json": "{}",
    "helper/index.js": "x",
  });
  const v = await resolveVendor({
    addon,
    reviewerInstalls: true,
    enabled: false,
  });
  // Named, not merely non-empty: the surviving entry has to be the tarball.
  assert.deepEqual(v.unsupportedDeps, [
    { name: "payload", spec: "file:./libs/payload.tgz", file: "package.json" },
  ]);
});

// A file: spec declared by a NESTED package file that escapes the submission (or names
// nothing present) stays unsupported exactly as a root-level one does - anchored at the
// nested package file, not at the root package.json, so the reviewer is pointed at the file
// that actually declared it.
test("resolveVendor keeps an unresolvable file: spec unsupported, anchored at the nested package file", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { nested: "file:./nested" },
    }),
    "nested/package.json": JSON.stringify({
      dependencies: { escape: "file:../../outside" }, // nothing exists above the root
    }),
    "nested/index.js": "export {};\n",
  });
  const v = await resolveVendor({
    addon,
    reviewerInstalls: true,
    enabled: false,
  });
  assert.deepEqual(v.unsupportedDeps, [
    { name: "escape", spec: "file:../../outside", file: "nested/package.json" },
  ]);
});

// ---- verifiedVendorSource ----
// The one strong statement the vendor pipeline makes about a file's CONTENT. Read by
// remote-resources to decide whether a remote load is upstream's line or the
// developer's, so every way it can be wrong is a wrongly-granted exemption.
const row = (path, outcome, source = "https://cdn.example/x@1.0.0/x.css") => ({
  path,
  source,
  outcome,
});

test("verifiedVendorSource answers only for a verified content match", () => {
  const yes = { vendor: { results: [row("a.css", "verified")] } };
  assert.equal(
    verifiedVendorSource(yes, "a.css"),
    "https://cdn.example/x@1.0.0/x.css"
  );
  // A different file, no store, no results, no addon: all null, never a throw.
  assert.equal(verifiedVendorSource(yes, "b.css"), null);
  assert.equal(verifiedVendorSource({ vendor: {} }, "a.css"), null);
  assert.equal(verifiedVendorSource({}, "a.css"), null);
  assert.equal(verifiedVendorSource(null, "a.css"), null);
  for (const outcome of [
    "modified",
    "unpinned-source",
    "not-popular",
    "no-url",
    "untrusted",
  ]) {
    assert.equal(
      verifiedVendorSource(
        { vendor: { results: [row("a.css", outcome)] } },
        "a.css"
      ),
      null,
      outcome
    );
  }
});

// A file declaration and a folder declaration covering the same path both push a row,
// so one path can carry two. Any non-verified row withdraws the vouching WHATEVER its
// position - otherwise the order two passes happened to run in would decide whether a
// modified file is exempt.
test("verifiedVendorSource is order-independent across two rows for one path", () => {
  for (const results of [
    [row("a.css", "verified"), row("a.css", "modified")],
    [row("a.css", "modified"), row("a.css", "verified")],
  ]) {
    assert.equal(verifiedVendorSource({ vendor: { results } }, "a.css"), null);
  }
});

// The untrusted reconciliation (applyUnverifiedVendor -> markUntrusted) DELETES the
// unverified rows it consumed, so results alone cannot see that contradiction. The
// untrusted list is what still remembers it, and the stricter half must win.
test("verifiedVendorSource refuses a file the untrusted reconciliation touched", () => {
  const addon = {
    vendor: { results: [row("a.css", "verified")] },
    bundled: { untrusted: [{ file: "a.css", unreadable: false }] },
  };
  assert.equal(verifiedVendorSource(addon, "a.css"), null);
  // ... and leaves every other file alone.
  addon.vendor.results.push(row("b.css", "verified"));
  assert.ok(verifiedVendorSource(addon, "b.css"));
});

// ---- declaredFiles: the unit a results row is written about ----
// A row's `path` must always name a file, never a directory: markUntrusted withdraws
// an exemption by removing a path from the non-authored set, and removing "lib" does
// nothing for the "lib/..." entries actually in it. A folder declaration against a
// source we cannot check would then leave its files exempt AND unscanned, while the
// same source declared file-by-file is reviewed.
test("declaredFiles expands a folder declaration to the files under it", () => {
  const addon = fakeAddon({
    "lib/a.js": "a",
    "lib/deep/b.js": "b",
    "library.js": "not under lib/",
    "other.js": "c",
  });
  assert.deepEqual(
    declaredFiles(addon, { path: "lib", kind: "folder" }).sort(),
    ["lib/a.js", "lib/deep/b.js"]
  );
  // A prefix that only looks like one is not covered ("library.js" vs "lib/").
  assert.ok(
    !declaredFiles(addon, { path: "lib", kind: "folder" }).includes(
      "library.js"
    )
  );
  // A folder covering nothing yields nothing; whether the declaration names something
  // absent is missing-vendor-file's question.
  assert.deepEqual(declaredFiles(addon, { path: "gone", kind: "folder" }), []);
});

// A FILE declaration is returned as declared, packaged or not - this helper only
// answers which files a declaration covers; expanding a file declaration is not its
// job.
test("declaredFiles leaves a file declaration alone", () => {
  const addon = fakeAddon({ "lib/a.js": "a" });
  assert.deepEqual(declaredFiles(addon, { path: "lib/a.js", kind: "file" }), [
    "lib/a.js",
  ]);
  assert.deepEqual(declaredFiles(addon, { path: "absent.js", kind: "file" }), [
    "absent.js",
  ]);
});

// The end the consumers see: an unverifiable FOLDER declaration produces one row per
// covered file, so nothing downstream has to ask what kind of declaration made it.
test("an unverifiable folder declaration yields one results row per file", async () => {
  const addon = fakeAddon({
    "VENDOR.md":
      "- folder: lib\n  source: https://evil.example.com/w/1.2.3/i.js\n",
    "lib/a.js": "a",
    "lib/b.js": "b",
  });
  const vendor = await resolveVendor({ addon });
  assert.deepEqual(vendor.results.map((r) => [r.path, r.outcome]).sort(), [
    ["lib/a.js", "untrusted"],
    ["lib/b.js", "untrusted"],
  ]);
  // The folder is still vendored by prefix - the rows say what was CHECKED, not what
  // was declared.
  assert.deepEqual([...vendor.folders], ["lib"]);
});

// An outcome that REJECTS re-decides nothing per file: the submission is refused until
// the developer pins the source, and until then no covered file's status changes. So
// the row names the DECLARATION - expanding it would report one complaint about one
// declaration once per file it happens to cover.
test("an unpinned folder declaration yields ONE row, naming the declaration", async () => {
  const addon = fakeAddon({
    "VENDOR.md":
      "- folder: lib\n  source: https://unpkg.com/demo-widget/dist/index.js\n",
    "lib/a.js": "a",
    "lib/b.js": "b",
  });
  const vendor = await resolveVendor({ addon });
  assert.deepEqual(
    vendor.results.map((r) => [r.path, r.outcome]),
    [["lib", "unpinned-source"]]
  );
});
