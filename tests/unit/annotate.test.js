// Unit tests for applySchemaAnnotations - the overwrite-merge that lays local
// annotation fragments onto loaded schema files, value-directed (each enum-value
// annotation lands on the node whose enum lists it). loadSchemaAnnotations
// (locating the bundled fragment) is exercised via schema-index.test.js and the
// golden harness.

import { test } from "node:test";
import assert from "node:assert/strict";

import { applySchemaAnnotations } from "../../src/schema/annotate.js";

// A schema type whose enum values live in a choice (like manifest.OptionalPermission):
// a $ref choice plus a string-enum choice.
const files = () => ({
  "manifest.json": [
    {
      namespace: "manifest",
      types: [
        {
          id: "OptionalPermission",
          choices: [
            { $ref: "PermissionNoPrompt" },
            { type: "string", enum: ["clipboardWrite", "geolocation"] },
          ],
        },
      ],
    },
  ],
});

const webApi = (receiver, methods) => ({
  annotations: [
    { additional_properties: { web_api: [{ receiver, methods }] } },
  ],
});

// A type-level fragment enum lands on the choice that lists the value - not the
// $ref choice, not the type.
const fragment = (enums) => ({
  "manifest.json": [
    { namespace: "manifest", types: [{ id: "OptionalPermission", enums }] },
  ],
});

test("lands each enum annotation on the choice that lists the value", () => {
  const f = files();
  applySchemaAnnotations(
    f,
    fragment({ clipboardWrite: webApi("navigator.clipboard", ["writeText"]) })
  );
  const [refChoice, enumChoice] = f["manifest.json"][0].types[0].choices;
  assert.deepEqual(
    enumChoice.enums.clipboardWrite,
    webApi("navigator.clipboard", ["writeText"])
  );
  assert.ok(!("enums" in refChoice));
});

// An existing enum entry is replaced, not duplicated or deep-appended.
test("overwrites an existing enum entry", () => {
  const f = files();
  f["manifest.json"][0].types[0].choices[1].enums = {
    clipboardWrite: webApi("old.receiver", ["old"]),
  };
  applySchemaAnnotations(
    f,
    fragment({ clipboardWrite: webApi("navigator.clipboard", ["writeText"]) })
  );
  const entry = f["manifest.json"][0].types[0].choices[1].enums.clipboardWrite;
  assert.deepEqual(entry, webApi("navigator.clipboard", ["writeText"]));
  assert.equal(entry.annotations.length, 1); // overwritten, not appended
});

// A value on the type's own enum lands on the type (not only choices).
test("lands on the type itself when the type carries the enum", () => {
  const f = {
    "manifest.json": [
      {
        namespace: "manifest",
        types: [{ id: "PermissionNoPrompt", enum: ["storage", "alarms"] }],
      },
    ],
  };
  applySchemaAnnotations(f, {
    "manifest.json": [
      {
        namespace: "manifest",
        types: [
          { id: "PermissionNoPrompt", enums: { storage: webApi("x", ["y"]) } },
        ],
      },
    ],
  });
  assert.deepEqual(
    f["manifest.json"][0].types[0].enums.storage,
    webApi("x", ["y"])
  );
});

// A fragment value/namespace/type not present in the schema is a no-op.
test("is a no-op for an absent namespace, type, or value", () => {
  const f = files();
  const before = JSON.stringify(f);
  applySchemaAnnotations(f, fragment({ notAPermission: webApi("r", ["m"]) }));
  applySchemaAnnotations(f, {
    "manifest.json": [
      {
        namespace: "nope",
        types: [{ id: "X", enums: { a: webApi("r", ["m"]) } }],
      },
    ],
  });
  applySchemaAnnotations(f, {
    "other.json": [{ namespace: "manifest", types: [] }],
  });
  assert.equal(JSON.stringify(f), before);
});
