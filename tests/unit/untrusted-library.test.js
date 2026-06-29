// Unit tests for the two checks that consume addon.bundled.untrusted (an
// identified-but-not-popular library, see markUntrusted): untrusted-library (info,
// readable -> reviewed as authored code) and untrusted-minified-library (error,
// unreadable -> ship a readable build). Each picks only its own readability.

import { test } from "node:test";
import assert from "node:assert/strict";

import untrustedLibrary from "../../src/checks/rules/untrusted-library.js";
import untrustedMinified from "../../src/checks/rules/untrusted-minified-library.js";

const ctxWith = (untrusted) => ({
  addon: { bundled: { classified: [], nonAuthored: new Set(), untrusted } },
});

// A readable untrusted lib is the info check's; the reject check stays silent.
test("untrusted-library (info) reports the readable entries only", () => {
  const ctx = ctxWith([
    {
      file: "vendor/x.js",
      source: "https://unpkg.com/x@1.0.0/x.js",
      name: "x 1.0.0",
      unreadable: false,
    },
    {
      file: "vendor/y.min.js",
      source: "https://cdn/y",
      name: "y 2.0.0",
      unreadable: true,
    },
  ]);
  const info = untrustedLibrary.run(ctx);
  assert.equal(info.length, 1);
  assert.equal(info[0].file, "vendor/x.js");
  assert.equal(info[0].item, "x 1.0.0");
  assert.equal(untrustedMinified.run(ctx).length, 1); // the .min.js is the reject check's
});

// An unreadable untrusted lib is the reject check's; the info check stays silent.
test("untrusted-minified-library (reject) reports the unreadable entries only", () => {
  const ctx = ctxWith([
    {
      file: "vendor/y.min.js",
      source: "https://cdn/y",
      name: "y 2.0.0",
      unreadable: true,
    },
  ]);
  const rejects = untrustedMinified.run(ctx);
  assert.equal(rejects.length, 1);
  assert.equal(rejects[0].file, "vendor/y.min.js");
  assert.equal(rejects[0].item, "y 2.0.0");
  assert.equal(untrustedLibrary.run(ctx).length, 0);
});

// With no name (e.g. a VENDOR source whose release id was not parsed), the item
// falls back to the file path; both checks are silent on an empty list.
test("item falls back to the file path; empty list yields nothing", () => {
  const ctx = ctxWith([
    {
      file: "dep/extract-time.js",
      source: "https://unpkg.com/x@4/index.js",
      unreadable: false,
    },
  ]);
  assert.equal(untrustedLibrary.run(ctx)[0].item, "dep/extract-time.js");
  assert.equal(untrustedMinified.run(ctxWith([])).length, 0);
  assert.equal(untrustedLibrary.run(ctxWith([])).length, 0);
});
