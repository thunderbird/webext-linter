// Unit tests for small shared helpers: src/lib/util.js, src/util/files.js and
// src/util/log.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseVersion, cmpVersion } from "../../src/lib/util.js";
import { extname, basename } from "../../src/util/files.js";

// Version parsing: numeric tuples per component, leading non-digits dropped, and
// null for nothing-numeric or the "≤"/"<"-prefixed pre-WebExtension marker.
test("parseVersion reads numeric component tuples", () => {
  assert.deepEqual(parseVersion("115.0"), [115, 0]);
  assert.deepEqual(parseVersion("140.4.1"), [140, 4, 1]);
  assert.deepEqual(parseVersion(" 154 "), [154]);
  assert.deepEqual(parseVersion("0a1"), [0]);
  assert.equal(parseVersion("≤59"), null);
  assert.equal(parseVersion("<60"), null);
  assert.equal(parseVersion("abc"), null);
  assert.equal(parseVersion(undefined), null);
});

// Component-wise compare, missing components treated as 0.
test("cmpVersion compares component-wise", () => {
  assert.equal(cmpVersion([154], [154, 0]), 0);
  assert.equal(cmpVersion([153, 9], [154]), -1);
  assert.equal(cmpVersion([200], [154]), 1);
  assert.equal(cmpVersion([140, 4, 1], [140, 4]), 1);
});

// Only a file carries an extension, so the dot that names one has to be in the
// BASENAME. A versioned vendor directory (lib/jquery-3.6.0/LICENSE) holds a dot of
// its own, and lending it to the file would make an extensionless LICENSE look like
// it had an extension no rule can recognise - and cost it the documentation
// exemption that keeps a shipped licence out of the unused-files report. A leading
// dot still reads as an extension (.DS_Store), which is how junk is matched.
test("extname reads the extension from the basename, not the path", () => {
  assert.equal(extname("lib/jquery-3.6.0/LICENSE"), "");
  assert.equal(extname("vendor/pdf-lib-1.17.1/LICENSE"), "");
  assert.equal(extname("x/y.z/Dockerfile"), "");
  assert.equal(extname("assets/i18n.v2/messages"), "");
  // A real extension is still read, dotted directory or not.
  assert.equal(extname("lib/v1.2/script.js"), ".js");
  assert.equal(extname("README.de.md"), ".md");
  assert.equal(extname("icons/16x16/icon.png"), ".png");
  assert.equal(extname("LICENSE"), "");
  assert.equal(extname(".DS_Store"), ".ds_store");
  assert.equal(basename("lib/jquery-3.6.0/LICENSE"), "LICENSE");
});
