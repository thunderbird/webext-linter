// Unit tests for the Mozilla-policy library blocklist: parsing the curated
// assets/library-blocks.yaml, matching a (name, version) to a banned/unadvised
// verdict, and the banned-library check that reports the recorded hits. No network.
// The Setup-phase short-circuit (auditNpm skips OSV for a banned library) is in
// vendor-verify.test.js, where the vendor-audit net stub lives.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveLibraryBlocks,
  parseLibraryBlocks,
  matchLibraryBlock,
} from "../../src/lib/library-blocks.js";
import bannedLibrary from "../../src/checks/rules/banned-library.js";

// ---- parseLibraryBlocks ----

test("parseLibraryBlocks reads entries keyed by npm name, skipping malformed ones", () => {
  const blocks = parseLibraryBlocks(`
- name: jquery
  banned_below: "3.0.0"
  reason: "old jquery"
- name: dompurify
  unadvised_below: "2.4.0"
- notname: skip
`);
  assert.deepEqual([...blocks.keys()].sort(), ["dompurify", "jquery"]);
  assert.equal(blocks.get("jquery").bannedBelow, "3.0.0");
  assert.equal(blocks.get("jquery").reason, "old jquery");
  assert.equal(blocks.get("dompurify").unadvisedBelow, "2.4.0");
  assert.equal(blocks.get("dompurify").bannedBelow, null);
});

test("parseLibraryBlocks tolerates an empty / non-list document", () => {
  assert.equal(parseLibraryBlocks("").size, 0);
  assert.equal(parseLibraryBlocks("{}").size, 0);
  assert.equal(parseLibraryBlocks("null").size, 0);
});

// ---- matchLibraryBlock ----

test("matchLibraryBlock: banned below, unadvised below, clean at/above the threshold", () => {
  const blocks = parseLibraryBlocks(`
- name: jquery
  banned_below: "3.0.0"
  reason: "R"
- name: dompurify
  unadvised_below: "2.4.0"
  reason: "D"
`);
  assert.deepEqual(matchLibraryBlock(blocks, "jquery", "2.2.4"), {
    status: "banned",
    reason: "R",
  });
  assert.equal(matchLibraryBlock(blocks, "jquery", "3.0.0"), null); // at the bound, not below
  assert.equal(matchLibraryBlock(blocks, "jquery", "3.5.1"), null);
  assert.deepEqual(matchLibraryBlock(blocks, "dompurify", "2.0.0"), {
    status: "unadvised",
    reason: "D",
  });
  assert.equal(matchLibraryBlock(blocks, "dompurify", "2.4.0"), null);
});

test("matchLibraryBlock: normalizes a dispensary alias (angularjs -> angular) and strips a v prefix", () => {
  const blocks = parseLibraryBlocks(`
- name: angular
  banned_below: "1.5.9"
  reason: "R"
`);
  assert.equal(
    matchLibraryBlock(blocks, "angularjs", "1.5.8").status,
    "banned"
  );
  assert.equal(matchLibraryBlock(blocks, "angular", "v1.5.8").status, "banned");
  assert.equal(matchLibraryBlock(blocks, "angularjs", "1.5.9"), null);
});

test("matchLibraryBlock: unknown name, unparseable version, and empty policy never match", () => {
  const blocks = parseLibraryBlocks(
    `- name: jquery\n  banned_below: "3.0.0"\n  reason: "R"`
  );
  assert.equal(matchLibraryBlock(blocks, "react", "0.0.1"), null); // not in policy
  assert.equal(matchLibraryBlock(blocks, "jquery", "not-a-version"), null);
  assert.equal(matchLibraryBlock(null, "jquery", "1.0.0"), null); // no policy loaded
  assert.equal(matchLibraryBlock(new Map(), "jquery", "1.0.0"), null);
});

test("matchLibraryBlock: banned takes precedence over unadvised (below both)", () => {
  const blocks = parseLibraryBlocks(`
- name: lib
  banned_below: "2.0.0"
  unadvised_below: "3.0.0"
  reason: "R"
`);
  assert.equal(matchLibraryBlock(blocks, "lib", "1.0.0").status, "banned"); // below both
  assert.equal(matchLibraryBlock(blocks, "lib", "2.5.0").status, "unadvised");
  assert.equal(matchLibraryBlock(blocks, "lib", "3.0.0"), null);
});

// ---- resolveLibraryBlocks (the shipped asset) ----

test("resolveLibraryBlocks reads the shipped default asset", async () => {
  const { text, source } = await resolveLibraryBlocks();
  assert.equal(source, "default");
  const blocks = parseLibraryBlocks(text);
  assert.ok(blocks.has("jquery") && blocks.has("angular"));
});

// ---- the banned-library check (pure reader of addon.vendor.blocked) ----

test("banned-library: banned -> error, unadvised -> warning, anchored at the declaration line", () => {
  const pkg = '{\n  "dependencies": {\n    "jquery": "2.2.4"\n  }\n}';
  const ctx = {
    addon: {
      files: new Map([["package.json", Buffer.from(pkg)]]),
      vendor: {
        blocked: [
          {
            name: "jquery",
            version: "2.2.4",
            status: "banned",
            reason: "old jquery",
            file: "package.json",
            token: "jquery",
          },
          {
            name: "dompurify",
            version: "2.0.0",
            status: "unadvised",
            reason: "old dompurify",
            file: "vendor/dompurify.js",
            token: "", // an identified library has no declaration line
          },
        ],
      },
    },
  };
  const out = bannedLibrary.run(ctx);
  assert.equal(out.length, 2);

  const jq = out.find((f) => f.item === "jquery");
  assert.equal(jq.severity, "error"); // banned -> error
  assert.equal(jq.file, "package.json");
  assert.equal(jq.loc.line, 3);
  assert.deepEqual(jq.data, {
    version: "2.2.4",
    reason: "old jquery",
    status: "disallowed",
  });

  const dp = out.find((f) => f.item === "dompurify");
  assert.equal(dp.severity, "warning"); // unadvised -> warning
  assert.equal(dp.file, "vendor/dompurify.js");
  assert.ok(!dp.loc); // no token -> anchors at the file, no line
  assert.equal(dp.data.status, "discouraged");
});

test("banned-library: no recorded hits -> no findings", () => {
  assert.deepEqual(
    bannedLibrary.run({ addon: { files: new Map(), vendor: { blocked: [] } } }),
    []
  );
  assert.deepEqual(
    bannedLibrary.run({ addon: { files: new Map(), vendor: {} } }),
    []
  );
});
