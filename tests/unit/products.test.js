// The review's data getters (src/review/products.js): computed on first ask, once per
// artifact, answering only final data, and a failure ends the review rather than becoming
// one check's.

import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewData } from "../../src/review/products.js";
import { defaultNet } from "../../src/vendor/verify.js";
import { LinterError } from "../../src/lib/errors.js";
import { ARTIFACT_SCA, ARTIFACT_XPI } from "../../src/lib/artifacts.js";
import { fixtureCacheOpts } from "../seed-caches.js";
import { addonOf } from "./manifest-ctx.js";

// The production network, which the switched-off test network makes refuse any request.
const OPTS = { ...fixtureCacheOpts(), cdnLookup: false, vendorNet: defaultNet };

const xpiReview = (files = { "a.js": "const x = 1;\n" }) => {
  const xpi = addonOf(files, ARTIFACT_XPI);
  const dataOf = reviewData({
    opts: OPTS,
    schema: { resolveApi: () => ({ kind: "unknown-namespace" }) },
    manifest: null,
    xpi,
    archive: null,
    target: xpi,
  });
  return { xpi, data: dataOf(xpi) };
};

test("each getter computes once, and answers every later ask from that result", async () => {
  const { data } = xpiReview();
  const [bundled, again] = await Promise.all([data.bundled(), data.bundled()]);
  assert.equal(bundled, again);
  assert.equal(await data.jsSources(), await data.jsSources());
  assert.equal(await data.apiUsages(), await data.apiUsages());
  assert.equal((await data.jsSources())[0].file, "a.js");
});

// The vendor reading is the review target's: the CDN identification rewrites its results and
// the audit appends to its lists, so it is handed out only once both have run.
test("the vendor reading is handed out final", async () => {
  const { xpi, data } = xpiReview();
  const vendor = await data.vendor();
  assert.equal(vendor, xpi.vendor);
  assert.ok(Array.isArray(vendor.vulnerabilities));
  assert.ok(xpi.bundled, "the classification and CDN step ran before it");
});

// Data only some artifacts have throws on the others: a check reading it was routed wrong.
test("data an artifact never has is a wiring error", async () => {
  const xpi = addonOf({ "a.js": "1;" }, ARTIFACT_XPI);
  const archive = addonOf({ "src.js": "1;" }, ARTIFACT_SCA);
  const dataOf = reviewData({
    opts: OPTS,
    schema: null,
    manifest: null,
    xpi,
    archive,
    target: archive,
  });
  await assert.rejects(
    () => dataOf(xpi).vendor(),
    /vendor reading is never computed for the built XPI/
  );
  await assert.rejects(
    () => dataOf(xpi).buildReview(),
    /build trace is never computed for the built XPI/
  );
});

// A stage that fails is reached from inside a check, whose own failures are contained; it is
// carried out as a LinterError, so the review ends with the original message.
test("a failing stage ends the review with its own message", async () => {
  // An artifact whose files cannot be walked: the classification throws a plain error.
  const xpi = { ...addonOf({}, ARTIFACT_XPI), files: null, store: null };
  const data = reviewData({
    opts: OPTS,
    schema: null,
    manifest: null,
    xpi,
    archive: null,
    target: xpi,
  })(xpi);
  await assert.rejects(
    () => data.bundled(),
    (err) => err instanceof LinterError && err.cause instanceof TypeError
  );
});
