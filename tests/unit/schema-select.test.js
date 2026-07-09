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
  detectManifestVersion,
  peekBranchMajor,
  resolveReviewSchema,
} from "../../src/pipeline.js";
import {
  schemaBranch,
  allSchemaBranches,
  cachedZipPath,
  hasAllCachedSchemas,
} from "../../src/schema/fetch.js";
import { peekApplicationVersion } from "../../src/schema/load.js";

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
