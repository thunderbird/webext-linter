// Unit tests for update-url: a self-hosted update_url is rejected in EITHER valid
// location - the current browser_specific_settings.gecko or the deprecated MV2
// applications.gecko alias - any manifest version. One finding per present
// location, carrying the url and its manifest line. (The golden fixture
// update-url-bss covers the bss path end-to-end; the applications alias is not in
// the offline test schema, so its branch is exercised here.)

import { withManifest } from "./manifest-ctx.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import rule from "../../src/checks/rules/update-url.js";

// A ctx whose files carry the manifest.json text, so manifestPathLine can resolve
// the update_url line from the (pretty-printed) source.
const ctxOf = (manifest) => ({
  addon: {
    manifest,
    files: new Map([
      ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
    ]),
  },
});

const gecko = (container, mv = 3) => ({
  manifest_version: mv,
  name: "x",
  version: "1.0",
  [container]: { gecko: { update_url: "https://example.com/updates.json" } },
});

test("flags update_url under browser_specific_settings.gecko", () => {
  const out = rule.run(withManifest(ctxOf(gecko("browser_specific_settings"))));
  assert.equal(out.length, 1);
  assert.equal(out[0].item, "https://example.com/updates.json");
  assert.ok(out[0].loc?.line > 0); // located at its manifest line
});

// The deprecated MV2 alias is rejected the same way.
test("flags update_url under the applications.gecko alias", () => {
  const out = rule.run(withManifest(ctxOf(gecko("applications", 2))));
  assert.equal(out.length, 1);
  assert.equal(out[0].item, "https://example.com/updates.json");
  assert.ok(out[0].loc?.line > 0);
});

// Present in both locations -> one finding each (both must go).
test("flags both locations independently", () => {
  const m = {
    manifest_version: 2,
    browser_specific_settings: { gecko: { update_url: "https://a.example/u" } },
    applications: { gecko: { update_url: "https://b.example/u" } },
  };
  const out = rule.run(withManifest(ctxOf(m)));
  assert.deepEqual(out.map((f) => f.item).sort(), [
    "https://a.example/u",
    "https://b.example/u",
  ]);
});

// A manifest with no update_url (and an unrelated gecko block) is clean.
test("no finding when update_url is absent", () => {
  const out = rule.run(
    withManifest(
      ctxOf({
        manifest_version: 3,
        browser_specific_settings: { gecko: { strict_min_version: "128.0" } },
      })
    )
  );
  assert.deepEqual(out, []);
});

// An unparsed manifest yields no findings and does not throw.
test("no finding (no throw) when the manifest did not parse", () => {
  const out = rule.run(withManifest({ addon: { manifest: null } }));
  assert.deepEqual(out, []);
});
