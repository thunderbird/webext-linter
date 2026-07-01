// Unit tests for the split manifest checks: the manifest-* error-level defects
// (invalid JSON, missing manifest/key, version mismatch, unknown permission) and
// the unrecognized-manifest-key / mistyped-manifest-value entries (deep ajv).
// Severity is left unset by the rules - runChecks stamps the yaml entry type.

import { withManifest } from "./manifest-ctx.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import manifestInvalidJson from "../../src/checks/rules/manifest-invalid-json.js";
import manifestMissing from "../../src/checks/rules/manifest-missing.js";
import manifestMissingKey from "../../src/checks/rules/manifest-missing-key.js";
import manifestVersionMismatch from "../../src/checks/rules/manifest-version-mismatch.js";
import manifestUnknownPermission from "../../src/checks/rules/manifest-unknown-permission.js";
import unrecognizedKey from "../../src/checks/rules/unrecognized-manifest-key.js";
import mistypedValue from "../../src/checks/rules/mistyped-manifest-value.js";
import { loadSchemaFiles } from "../../src/schema/load.js";
import { buildSchemaIndex } from "../../src/schema/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = buildSchemaIndex(
  loadSchemaFiles(path.join(here, "..", "schema-fixture"))
);

const ctx = (manifest) => ({ addon: { manifest }, schema });

// A minimal well-typed MV3 manifest yields zero findings from every check.
test("accepts a well-typed manifest", () => {
  const m = { manifest_version: 3, name: "x", version: "1.0" };
  for (const check of [
    manifestMissingKey,
    manifestVersionMismatch,
    manifestUnknownPermission,
    unrecognizedKey,
    mistypedValue,
  ]) {
    assert.equal(check.run(withManifest(ctx(m))).length, 0);
  }
});

// An unparsable manifest is manifest-invalid-json's finding; the others stay
// silent (they need a parsed manifest). A genuinely absent one is
// manifest-missing.
test("invalid JSON and a missing manifest are their own checks", () => {
  const broken = { addon: { manifestError: "boom", manifest: null }, schema };
  assert.equal(manifestInvalidJson.run(withManifest(broken)).length, 1);
  assert.equal(manifestMissing.run(withManifest(broken)).length, 0);
  assert.equal(manifestMissingKey.run(withManifest(broken)).length, 0);

  const absent = { addon: { manifest: null }, schema };
  assert.equal(manifestMissing.run(withManifest(absent)).length, 1);
  assert.equal(manifestInvalidJson.run(withManifest(absent)).length, 0);
});

// manifest_version as the string "3" trips ajv's type rule in
// mistyped-manifest-value (item = the path, data.detail = the ajv message); the
// error checks stay silent on type issues.
test("deep validation flags a wrongly-typed value (derived from the schema)", () => {
  const bad = { manifest_version: "3", name: "x", version: "1.0" };
  const findings = mistypedValue.run(withManifest(ctx(bad)));
  assert.ok(findings.some((f) => /manifest_version/.test(f.item)));
  assert.ok(findings.every((f) => f.severity === null));
  assert.equal(manifestMissingKey.run(withManifest(ctx(bad))).length, 0);
});

// Omitting "version" produces a manifest-missing-key finding naming the key.
test("manifest-missing-key flags a missing required key", () => {
  const out = manifestMissingKey.run(
    withManifest(ctx({ manifest_version: 3, name: "x" }))
  );
  assert.ok(out.some((f) => f.item === "version"));
});

// manifest_version disagreeing with the schema set (here MV3) is flagged: the
// declared version is the item, the schema major is supplementary data.
test("manifest-version-mismatch flags an MV2 manifest under the MV3 schema", () => {
  const out = manifestVersionMismatch.run(
    withManifest(ctx({ manifest_version: 2, name: "x", version: "1.0" }))
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].item, "2");
  assert.equal(out[0].data.schema, schema.manifestVersionMajor);
});

// A match pattern / known permission passes; an unknown one is flagged (item =
// the permission, listed on the location line by the report).
test("manifest-unknown-permission flags only unknown values", () => {
  const out = manifestUnknownPermission.run(
    withManifest(
      ctx({
        manifest_version: 3,
        name: "x",
        version: "1.0",
        permissions: ["https://example.com/*", "bogusPerm"],
      })
    )
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].item, "bogusPerm");
});

// An unknown top-level key is an unrecognized-manifest-key finding (item = key).
test("unrecognized-manifest-key flags an unknown top-level key", () => {
  const m = { manifest_version: 3, name: "x", version: "1.0", bogusKey: 1 };
  assert.ok(
    unrecognizedKey.run(withManifest(ctx(m))).some((f) => f.item === "bogusKey")
  );
});
