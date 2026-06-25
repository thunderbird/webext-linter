// Unit tests for unrecognized-manifest-key: a top-level key the schema does not
// define is flagged, EXCEPT one the add-on's own experiment owns - a key that
// NAMES an experiment_apis entry, or one the entry's schema DECLARES via a
// `manifest` $extend block.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import rule from "../../src/checks/rules/unrecognized-manifest-key.js";
import { buildSchemaIndex } from "../../src/schema/index.js";
import { loadSchemaFiles } from "../../src/schema/load.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = buildSchemaIndex(
  loadSchemaFiles(path.join(here, "..", "schema-fixture"))
);

// A ctx whose files include the manifest.json text (for token-line lookup) plus
// any extra files (e.g. an experiment schema).
const ctxOf = (manifest, extra = {}) => ({
  addon: {
    manifest,
    files: new Map(
      Object.entries({
        "manifest.json": JSON.stringify(manifest, null, 2),
        ...extra,
      }).map(([k, v]) => [k, Buffer.from(v)])
    ),
  },
  schema,
});

const items = (out) => out.map((f) => f.item).sort();

test("flags a genuinely unknown top-level key", () => {
  const out = rule.run(ctxOf({ manifest_version: 3, bogus_key: 1 }));
  assert.deepEqual(items(out), ["bogus_key"]);
});

// The calendar-tools shape: a key the add-on's own experiment schema declares via
// a `manifest` $extend block is owned by the developer - not flagged - while a
// genuinely unknown sibling key still is.
test("exempts a key declared by an experiment schema's manifest block", () => {
  const manifest = {
    manifest_version: 3,
    calendar_item_action: {},
    bogus_key: 1,
    experiment_apis: { cal: { schema: "exp/cal.json" } },
  };
  const schemaJson = JSON.stringify([
    {
      namespace: "manifest",
      types: [
        {
          $extend: "WebExtensionManifest",
          properties: { calendar_item_action: {} },
        },
      ],
    },
    { namespace: "calendarItemAction" },
  ]);
  const out = rule.run(ctxOf(manifest, { "exp/cal.json": schemaJson }));
  assert.deepEqual(items(out), ["bogus_key"]);
});

// The pre-existing exemption: a key that NAMES an experiment_apis entry.
test("exempts a key that names an experiment_apis entry", () => {
  const out = rule.run(
    ctxOf({
      manifest_version: 3,
      calendar_provider: {},
      experiment_apis: { calendar_provider: {} },
    })
  );
  assert.deepEqual(items(out), []);
});
