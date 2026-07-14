// Unit tests for buildRecheckVerdictReport: the per-site display rows shown under the
// add-on summary in the text report. It resolves each handed candidate back to its
// file:line + subject + source line, reading each consumer's OWN corpus.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRecheckVerdictReport } from "../../src/lib/recheck.js";

// A registry stub: titles + the per-consumer corpus artifact (source vs xpi).
const registry = {
  checkEntry: (id) =>
    ({
      "unused-permission-recheck": { title: "Unused permission" },
      "unused-files-recheck": { title: "Unused files" },
    })[id] ?? {},
  labelInputFor: (id) => (id === "unused-files-recheck" ? "xpi" : "source"),
};

const buf = (s) => Buffer.from(s, "utf8");

test("resolves per-occurrence, holistic, and non-permission verdicts to file:line + subject + line", () => {
  const manifest =
    '{\n  "permissions": [\n    "compose",\n    "unlimitedStorage"\n  ]\n}';
  const source = new Map([
    ["manifest.json", buf(manifest)],
    ["bg.js", buf("a();\nb();\nmessenger.scripting.executeScript(t);\n")],
  ]);
  // A different corpus for the xpi-anchored consumer, with distinct content on the same line.
  const xpi = new Map([["lib/x.js", buf("// header\nconst UNUSED = 1;\n")]]);

  const ctx = {
    // A manifest.json locus reads the SHIPPED manifest text (ctx.manifestText), not the
    // producer's corpus - matching manifestLoc + the [XPI] label.
    manifestText: manifest,
    recheck: new Map([
      [
        "unused-permission-recheck",
        [
          {
            item: "compose",
            file: "manifest.json",
            loc: { line: 3 },
            occurrences: [
              {
                id: "compose#1",
                file: "bg.js",
                line: 3,
                token: "scripting.executeScript",
              },
            ],
          },
          // holistic (no occurrences) -> keyed by the permission itself, manifest locus.
          {
            item: "unlimitedStorage",
            file: "manifest.json",
            loc: { line: 4 },
            occurrences: [],
          },
        ],
      ],
      [
        "unused-files-recheck",
        [{ item: null, hint: null, file: "lib/x.js", loc: { line: 2 } }],
      ],
    ]),
    recheckVerdicts: [
      {
        check: "unused-permission-recheck",
        item: "compose#1",
        verdict: "pass",
      },
      {
        check: "unused-permission-recheck",
        item: "unlimitedStorage",
        verdict: "fail",
      },
      { check: "unused-files-recheck", item: "lib/x.js:2", verdict: "unsure" },
      // a verdict for an item never handed over -> inert, dropped.
      { check: "unused-permission-recheck", item: "ghost#9", verdict: "pass" },
    ],
  };
  const corpusForCheck = (id) => ({
    files: id === "unused-files-recheck" ? xpi : source,
  });

  const rows = buildRecheckVerdictReport(ctx, registry, corpusForCheck);
  const by = (subject) => rows.find((r) => r.subject === subject);

  assert.equal(rows.length, 3); // ghost#9 dropped

  // Per-occurrence permission verdict: locus from the occurrence, subject = the permission,
  // source line from the SOURCE corpus.
  assert.deepEqual(by("compose"), {
    check: "Unused permission",
    label: "source",
    file: "bg.js",
    line: 3,
    subject: "compose",
    verdict: "pass",
    content: "messenger.scripting.executeScript(t);",
  });

  // Holistic permission verdict: keyed by the permission, manifest locus + line content.
  assert.deepEqual(by("unlimitedStorage"), {
    check: "Unused permission",
    label: "source",
    file: "manifest.json",
    line: 4,
    subject: "unlimitedStorage",
    verdict: "fail",
    content: '"unlimitedStorage"',
  });

  // Non-permission consumer: file:line key, xpi-anchored -> read from the XPI corpus.
  assert.deepEqual(
    by(undefined) ?? rows.find((r) => r.check === "Unused files"),
    {
      check: "Unused files",
      label: "xpi",
      file: "lib/x.js",
      line: 2,
      subject: null,
      verdict: "unsure",
      content: "const UNUSED = 1;",
    }
  );
});

test("a non-permission verdict takes its subject from the ref hint", () => {
  const ctx = {
    recheck: new Map([
      [
        "data-exfiltration-recheck",
        [{ item: null, hint: "fetch()", file: "bg.js", loc: { line: 1 } }],
      ],
    ]),
    recheckVerdicts: [
      { check: "data-exfiltration-recheck", item: "bg.js:1", verdict: "fail" },
    ],
  };
  const rows = buildRecheckVerdictReport(
    { ...ctx },
    {
      checkEntry: () => ({ title: "Exfiltration" }),
      labelInputFor: () => "source",
    },
    () => ({ files: new Map([["bg.js", buf("fetch(url, { body });\n")]]) })
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, "fetch()"); // hint, since item is null
  assert.equal(rows[0].content, "fetch(url, { body });");
});

// The manifest is cross-artifact: its line is numbered against and labelled as the SHIPPED
// manifest, so a manifest.json row must read ctx.manifestText, NOT the producer's (source)
// corpus - even when the two differ (a build can transform the manifest).
test("a manifest.json locus reads the shipped manifest text, not the source corpus", () => {
  const shipped = '{\n  "permissions": [\n    "unlimitedStorage"\n  ]\n}';
  const sourceManifest = '{\n  "permissions": [\n    "SOMETHING_ELSE"\n  ]\n}';
  const ctx = {
    manifestText: shipped,
    recheck: new Map([
      [
        "unused-permission-recheck",
        [
          {
            item: "unlimitedStorage",
            file: "manifest.json",
            loc: { line: 3 },
            occurrences: [],
          },
        ],
      ],
    ]),
    recheckVerdicts: [
      {
        check: "unused-permission-recheck",
        item: "unlimitedStorage",
        verdict: "fail",
      },
    ],
  };
  const rows = buildRecheckVerdictReport(ctx, registry, () => ({
    files: new Map([["manifest.json", buf(sourceManifest)]]),
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, '"unlimitedStorage"'); // shipped, not SOMETHING_ELSE
});

// The table is driven by the HANDED candidates, not the model's returned verdicts: if the model
// under-answers - or returns none at all (ignoring the recheck section) - every handed site still
// appears, defaulting to `unsure` (the same default the resolve applies -> manual). This is the fix
// for "model returned nothing -> empty table".
test("a handed candidate with no model verdict is shown as unsure, never dropped", () => {
  const ctx = {
    recheck: new Map([
      [
        "unused-permission-recheck",
        [
          {
            item: "messagesModify",
            file: "manifest.json",
            loc: { line: 5 },
            occurrences: [
              {
                id: "messagesModify#1",
                file: "bg.js",
                line: 1,
                token: "tabs.executeScript",
              },
              {
                id: "messagesModify#2",
                file: "bg.js",
                line: 2,
                token: "tabs.insertCSS",
              },
            ],
          },
        ],
      ],
    ]),
    recheckVerdicts: [], // the model answered nothing
  };
  const rows = buildRecheckVerdictReport(ctx, registry, () => ({
    files: new Map([
      [
        "bg.js",
        buf("browser.tabs.executeScript(t);\nbrowser.tabs.insertCSS(t);\n"),
      ],
    ]),
  }));
  assert.equal(rows.length, 2); // both sites shown despite no verdict
  assert.ok(
    rows.every((r) => r.verdict === "unsure" && r.subject === "messagesModify")
  );
  assert.deepEqual(
    rows.map((r) => r.line).sort((a, b) => a - b),
    [1, 2]
  );
  assert.equal(rows[0].content, "browser.tabs.executeScript(t);");
});

test("empty when nothing was handed to any recheck", () => {
  assert.deepEqual(
    buildRecheckVerdictReport({}, registry, () => ({ files: new Map() })),
    []
  );
});
