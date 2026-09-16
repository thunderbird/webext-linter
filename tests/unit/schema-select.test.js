// Unit tests for automatic schema selection: the pure channel selector
// (selectSchemaChannel), manifest-version detection, and the fetch/load helpers
// that back it (branch naming, cache-completeness, applicationVersion peeking).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

import {
  selectSchemaChannel,
  schemaSnapshotIsStale,
  detectManifestVersion,
  peekBranchMajor,
  resolveReviewSchema,
  resolveXpiOnlyAdvice,
} from "../../src/pipeline.js";
import {
  schemaBranch,
  allSchemaBranches,
  cachedZipPath,
  hasAllCachedSchemas,
} from "../../src/schema/fetch.js";
import { peekApplicationVersion } from "../../src/schema/load.js";
import { VERDICT } from "../../src/lib/enum.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FIXTURE = path.join(here, "..", "schema-fixture");

// Write a minimal cached branch zip stamped with an applicationVersion, mirroring
// the codeload layout (webext-annotated-schemas-<branch>/schema-files/*.json).
function writeBranchZip(cacheDir, branch, appVersion) {
  const zip = new AdmZip();
  const body = JSON.stringify([
    { namespace: "manifest", applicationVersion: appVersion },
  ]);
  zip.addFile(
    `webext-annotated-schemas-${branch}/schema-files/manifest.json`,
    Buffer.from(body)
  );
  zip.writeZip(cachedZipPath(cacheDir, branch));
}

// A complete, readable canonical cache (all six branches) stamped per channel, so
// resolveReviewSchema never triggers a (network) refresh.
function seedCache(cacheDir, { release, esr, beta }) {
  const versions = { release, esr, beta };
  for (const channel of ["release", "esr", "beta"]) {
    for (const mv of [2, 3]) {
      writeBranchZip(cacheDir, `${channel}-mv${mv}`, versions[channel]);
    }
  }
}

// Candidates are ALWAYS passed in channel priority order (release > esr > beta),
// as the pipeline builds them - the selector relies on that for tie-breaks.
const CANDS = [
  { channel: "release", branch: "release-mv3", major: 152 },
  { channel: "esr", branch: "esr-mv3", major: 140 },
  { channel: "beta", branch: "beta-mv3", major: 153 },
];

const pick = (strictMax, candidates = CANDS) =>
  selectSchemaChannel({ candidates, strictMax }).channel;

// The upper bound (strict_max_version) drives selection: an exact major match on a
// cached train wins (that train's version_added, incl. backports, is authoritative).
test("selectSchemaChannel: strict_max in the ESR major → esr (backport case)", () => {
  assert.equal(pick("140.*"), "esr");
  assert.equal(pick("140.5"), "esr");
  assert.equal(pick("140"), "esr");
});

test("selectSchemaChannel: strict_max in the release/beta major → that train", () => {
  assert.equal(pick("152.*"), "release");
  assert.equal(pick("153.*"), "beta");
});

// No cap, or a cap matching no cached train (a gap between trains, below the
// oldest, or above the newest), falls back to release - never rejects.
test("selectSchemaChannel: no cap → release", () => {
  assert.equal(pick(null), "release");
  assert.equal(pick(undefined), "release");
  assert.equal(pick(""), "release");
});

test("selectSchemaChannel: cap matching no cached train → release", () => {
  assert.equal(pick("145.*"), "release"); // gap between esr 140 and release 152
  assert.equal(pick("139.*"), "release"); // old release train, no schema
  assert.equal(pick("128.*"), "release"); // previous ESR, below all
  assert.equal(pick("200.*"), "release"); // future, above all
});

// An exact-major tie resolves to the earlier (more stable) channel: with a shared
// major the release entry (listed first) wins over beta.
test("selectSchemaChannel: exact-major tie → the higher-priority channel", () => {
  const tied = [
    { channel: "release", branch: "release-mv3", major: 152 },
    { channel: "esr", branch: "esr-mv3", major: 140 },
    { channel: "beta", branch: "beta-mv3", major: 152 },
  ];
  assert.equal(pick("152.*", tied), "release");
});

// Default fallback when release is unavailable: the newest-major candidate.
test("selectSchemaChannel: no release candidate → newest available on fallback", () => {
  const noRelease = [
    { channel: "esr", branch: "esr-mv3", major: 140 },
    { channel: "beta", branch: "beta-mv3", major: 153 },
  ];
  assert.equal(pick("999.*", noRelease), "beta");
});

test("selectSchemaChannel: empty candidate set throws", () => {
  assert.throws(() => selectSchemaChannel({ candidates: [], strictMax: null }));
});

test("selectSchemaChannel: reason names the chosen train", () => {
  assert.match(
    selectSchemaChannel({ candidates: CANDS, strictMax: "140.*" }).reason,
    /esr/
  );
  assert.match(
    selectSchemaChannel({ candidates: CANDS, strictMax: null }).reason,
    /no strict_max/
  );
});

test("detectManifestVersion: 2/3 detected; missing/invalid default to MV2", () => {
  assert.deepEqual(detectManifestVersion({ manifest_version: 3 }), {
    version: 3,
    detected: true,
  });
  assert.deepEqual(detectManifestVersion({ manifest_version: 2 }), {
    version: 2,
    detected: true,
  });
  assert.deepEqual(detectManifestVersion({}), { version: 2, detected: false });
  assert.deepEqual(detectManifestVersion(null), {
    version: 2,
    detected: false,
  });
  assert.deepEqual(detectManifestVersion({ manifest_version: 99 }), {
    version: 2,
    detected: false,
  });
});

test("schemaBranch / allSchemaBranches: the canonical six", () => {
  assert.equal(schemaBranch("esr", 3), "esr-mv3");
  const all = allSchemaBranches();
  assert.equal(all.length, 6);
  for (const b of [
    "release-mv2",
    "release-mv3",
    "esr-mv2",
    "esr-mv3",
    "beta-mv2",
    "beta-mv3",
  ]) {
    assert.ok(all.includes(b), `${b} missing`);
  }
});

test("cachedZipPath: cache dir + branch → zip path", () => {
  assert.equal(
    cachedZipPath("/c", "esr-mv3"),
    path.join("/c", "webext-annotated-schemas-esr-mv3.zip")
  );
});

test("hasAllCachedSchemas: true only when every canonical branch is present", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-cache-"));
  try {
    assert.equal(hasAllCachedSchemas(dir), false);
    const branches = allSchemaBranches();
    for (const b of branches.slice(0, -1)) {
      fs.writeFileSync(cachedZipPath(dir, b), "");
    }
    assert.equal(hasAllCachedSchemas(dir), false); // one still missing
    fs.writeFileSync(cachedZipPath(dir, branches.at(-1)), "");
    assert.equal(hasAllCachedSchemas(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("peekApplicationVersion: reads the stamp without a full index", () => {
  assert.equal(peekApplicationVersion(SCHEMA_FIXTURE), "128.0");
});

// resolveReviewSchema over a complete, readable cache: no refresh (no network),
// exactly one setup step, and the version range drives the branch + channel.
test("resolveReviewSchema: uncapped mv3 → release, one setup step, offline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-resolve-"));
  try {
    seedCache(dir, { release: "152.0.1", esr: "140.11.1esr", beta: "153.0" });
    let steps = 0;
    const r = await resolveReviewSchema({
      cacheDir: dir,
      manifest: {
        manifest_version: 3,
        browser_specific_settings: { gecko: {} },
      },
      setupStep: () => steps++,
    });
    assert.equal(r.channel, "release");
    assert.equal(r.branch, "release-mv3");
    assert.equal(steps, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveReviewSchema: strict_max 140.* mv3 → esr (backport case), offline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-resolve-"));
  try {
    seedCache(dir, { release: "152.0.1", esr: "140.11.1esr", beta: "153.0" });
    const r = await resolveReviewSchema({
      cacheDir: dir,
      manifest: {
        manifest_version: 3,
        browser_specific_settings: { gecko: { strict_max_version: "140.*" } },
      },
      setupStep: () => {},
    });
    assert.equal(r.channel, "esr");
    assert.equal(r.branch, "esr-mv3");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A missing or corrupt cached zip yields null, so the channel drops out of the
// candidate set instead of throwing - the resolver then re-downloads to self-heal.
test("peekBranchMajor: missing / corrupt zip → null, never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-peek-"));
  try {
    assert.equal(peekBranchMajor(dir, "release-mv3"), null); // no file
    fs.writeFileSync(cachedZipPath(dir, "esr-mv3"), "not a zip"); // corrupt
    assert.equal(peekBranchMajor(dir, "esr-mv3"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// resolveXpiOnlyAdvice: would an XPI-only submission have been enough? Advice only - it
// never re-routes the review (an SCA submission is always reviewed as SCA), so every
// answer below is about whether the developer is TOLD, not about what gets reviewed.
// A minimal Bundled: one minified first-party file => unreviewable.
const bundled = (files = []) => ({
  classified: files,
  nonAuthored: new Set(),
  untrusted: [],
});
const MINIFIED_FIRST_PARTY = {
  file: "bundle.js",
  minified: true,
  library: false,
  obfuscation: VERDICT.PASS,
};
/** An XPI whose files are named+valued by `spec`, for the shipped-bytes question. */
const xpi = (spec = {}) => ({
  files: new Map(
    Object.entries(spec).map(([f, t]) => [f, Buffer.from(t, "utf8")])
  ),
});
/** A source archive, same shape as what the pipeline slices out of --sca-source. */
const src = (spec = {}) =>
  new Map(Object.entries(spec).map(([f, t]) => [f, Buffer.from(t, "utf8")]));

const sca = { scaRoot: "src" };
// The twinned baseline every "does the OTHER question veto it?" case builds on: one
// shipped script, byte-identical in the archive. On its own it advises.
const TWIN_XPI = xpi({ "background.js": "console.log(1);\n" });
const TWIN_SRC = { "background.js": "console.log(1);\n" };

test("resolveXpiOnlyAdvice: no --sca-root -> no advice (nothing was submitted to advise about)", () => {
  assert.equal(resolveXpiOnlyAdvice({}, bundled()), false);
});

test("resolveXpiOnlyAdvice: an unreviewable (minified) XPI is never advised", () => {
  assert.equal(
    resolveXpiOnlyAdvice(
      sca,
      bundled([MINIFIED_FIRST_PARTY]),
      TWIN_XPI,
      src(TWIN_SRC)
    ),
    false
  );
});

test("resolveXpiOnlyAdvice: a readable XPI that IS the source is advised", () => {
  assert.equal(
    resolveXpiOnlyAdvice(sca, bundled([]), TWIN_XPI, src(TWIN_SRC)),
    true
  );
});

// Question 2: readable shipped bytes are not the same question as
// shipped-bytes-are-the-source. A transpiler's output reads perfectly, so the archive's
// source KINDS answer it - and this is the ONLY question that sees a non-JS build
// (.scss -> .css) where every script is copied verbatim.
test("resolveXpiOnlyAdvice: a transpiled source kind withholds the advice, twins or not", () => {
  for (const kind of [
    "app.ts",
    "a/b/Comp.vue",
    "ui.tsx",
    "m.svelte",
    "s.scss",
  ]) {
    assert.equal(
      resolveXpiOnlyAdvice(
        sca,
        bundled([]),
        TWIN_XPI,
        src({ ...TWIN_SRC, [kind]: "x" })
      ),
      false,
      `${kind} withholds the advice`
    );
  }
});

test("resolveXpiOnlyAdvice: a .d.ts is not a transpiled source", () => {
  // Types only, emits nothing, and plain-JS projects ship them. extname() reads ".ts"
  // from it, so excluding it by extension would veto exactly those projects.
  assert.equal(
    resolveXpiOnlyAdvice(
      sca,
      bundled([]),
      TWIN_XPI,
      src({ ...TWIN_SRC, "types.d.ts": "declare const x: number;" })
    ),
    true
  );
  // ...but a real .ts alongside one still withholds it.
  assert.equal(
    resolveXpiOnlyAdvice(
      sca,
      bundled([]),
      TWIN_XPI,
      src({ ...TWIN_SRC, "types.d.ts": "x", "app.ts": "y" })
    ),
    false
  );
});

// Question 3: are the shipped bytes THE SOURCE? The first two only answer "is the XPI
// readable?"; without this one, every bundler submission - webpack, Vite, a build
// copying from submodules - would be advised it needed no source archive.
test("resolveXpiOnlyAdvice: a shipped script absent from the archive withholds the advice", () => {
  assert.equal(
    resolveXpiOnlyAdvice(
      sca,
      bundled([]),
      xpi({ "content/app.bundle.js": "/* built */\n" }),
      src({ "content/app.mjs": "/* authored */\n" })
    ),
    false
  );
});

test("resolveXpiOnlyAdvice: a same-named script with different bytes withholds the advice", () => {
  assert.equal(
    resolveXpiOnlyAdvice(
      sca,
      bundled([]),
      TWIN_XPI,
      src({ "background.js": "console.log(2);\n" })
    ),
    false
  );
});

test("resolveXpiOnlyAdvice: the twin may sit at any path, and any one candidate suffices", () => {
  // Basename matching: a build that RELOCATES a file it copied verbatim still counts,
  // and so does a wrapper directory (GitHub's "Download ZIP").
  assert.equal(
    resolveXpiOnlyAdvice(
      sca,
      bundled([]),
      TWIN_XPI,
      src({ "deep/nested/background.js": TWIN_SRC["background.js"] })
    ),
    true
  );
  // Two candidates share the name; one matches.
  assert.equal(
    resolveXpiOnlyAdvice(
      sca,
      bundled([]),
      TWIN_XPI,
      src({
        "a/background.js": "console.log(999);\n",
        "b/background.js": TWIN_SRC["background.js"],
      })
    ),
    true
  );
});

test("resolveXpiOnlyAdvice: a shipped .cjs needs a twin too", () => {
  // JS_EXTENSIONS, not just .js/.mjs: Gecko loads background.scripts by path, so an
  // add-on whose code is all .cjs must not pass for free.
  assert.equal(
    resolveXpiOnlyAdvice(sca, bundled([]), xpi({ "bg.cjs": "a" }), src({})),
    false
  );
  assert.equal(
    resolveXpiOnlyAdvice(
      sca,
      bundled([]),
      xpi({ "bg.cjs": "a" }),
      src({ "bg.cjs": "a" })
    ),
    true
  );
});

test("resolveXpiOnlyAdvice: an identified library needs no twin, a DECLARED one does", () => {
  // The anti-bypass invariant. `tag.library` is a true content-hash match against the
  // known-library DB, so exempting it is evidence-based. A VENDOR.md declaration is a
  // CLAIM that Phase 3 has not verified yet, and it must not be able to buy this advice -
  // which is why the exempt set is built from `classified`, where vendored files never
  // appear at all.
  const LIB = {
    file: "lib/jquery.js",
    minified: false,
    library: true,
    obfuscation: VERDICT.PASS,
  };
  const shipped = xpi({
    "background.js": TWIN_SRC["background.js"],
    "lib/jquery.js": "/* upstream */\n",
  });
  assert.equal(
    resolveXpiOnlyAdvice(sca, bundled([LIB]), shipped, src(TWIN_SRC)),
    true
  );
  // Same file, but only DECLARED (never hash-identified, so absent from `classified`):
  // it still needs a twin, and has none.
  assert.equal(
    resolveXpiOnlyAdvice(sca, bundled([]), shipped, src(TWIN_SRC)),
    false
  );
});

test("resolveXpiOnlyAdvice: an archive that was never read withholds the advice", () => {
  assert.equal(
    resolveXpiOnlyAdvice(sca, bundled([]), TWIN_XPI, src({})),
    false
  );
  assert.equal(resolveXpiOnlyAdvice(sca, bundled([]), TWIN_XPI), false);
});

// A channel branch is a moving target, so a cached zip is a snapshot that goes stale the
// moment Thunderbird ships. It only MATTERS when the add-on's cap reaches past every
// cached train: the schema then cannot know the APIs in between, and a call to one is
// reported as unknown instead of as needing a newer strict_min_version. The age test is
// what stops every uncapped add-on from re-downloading six zips on every run.
test("a schema snapshot is stale only when the add-on outreaches it AND it is old", () => {
  const stale = (cap, newest, ageDays) =>
    schemaSnapshotIsStale({ cap, newest, ageDays });
  // The case from a real run: capped at 157, newest cached train 153, snapshot 2 months old.
  assert.equal(stale(157, 153, 62), true);
  // Fresh enough to be the current train, however far the add-on reaches.
  assert.equal(stale(157, 153, 0.5), false);
  assert.equal(stale(Infinity, 153, 0.5), false);
  // Within the cached trains: the schema describes it, so age does not matter.
  assert.equal(stale(152, 153, 999), false);
  assert.equal(stale(153, 153, 999), false);
  // No cap at all reads as reaching past everything, so only age holds it back.
  assert.equal(stale(Infinity, 153, 2), true);
  // An unreadable cache (age Infinity) asks to be refreshed only when the add-on also
  // outreaches the cached trains.
  assert.equal(stale(140, 153, Infinity), false);
  assert.equal(stale(Infinity, 153, Infinity), true);
});
