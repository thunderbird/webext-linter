// Unit tests for scanWebApiCalls - the AST match that grounds a Web/DOM-API
// permission from a navigator.* call. The signatures mirror the schema's `web_api`
// annotation; the reachability scoping and schema wiring (groundWebApiPermissions
// in src/lib/permissions.js) are covered via the golden harness.

import { test } from "node:test";
import assert from "node:assert/strict";

import { scanWebApiCalls } from "../../src/parse/web-api-calls.js";

const SIGNATURES = [
  {
    permission: "clipboardRead",
    receiver: "navigator.clipboard",
    methods: ["read", "readText"],
  },
  {
    permission: "clipboardWrite",
    receiver: "navigator.clipboard",
    methods: ["write", "writeText"],
  },
  {
    permission: "geolocation",
    receiver: "navigator.geolocation",
    methods: ["getCurrentPosition", "watchPosition", "clearWatch"],
  },
];

const scan = (code) => scanWebApiCalls(code, SIGNATURES);

// A direct call grounds exactly the permission whose receiver+method it matches;
// the shared receiver (navigator.clipboard) is disambiguated by the method.
test("grounds a permission from a direct navigator.* call", () => {
  assert.deepEqual(
    [...scan("navigator.clipboard.readText();")],
    ["clipboardRead"]
  );
  assert.deepEqual(
    [...scan("navigator.clipboard.writeText('x');")],
    ["clipboardWrite"]
  );
  assert.deepEqual(
    [...scan("navigator.geolocation.getCurrentPosition(cb);")],
    ["geolocation"]
  );
});

// String-literal bracket access is matched like dot access (a common obfuscation).
test("matches string-literal bracket access", () => {
  assert.deepEqual(
    [...scan('navigator["clipboard"]["read"]();')],
    ["clipboardRead"]
  );
});

// A const alias of the receiver still grounds the permission.
test("resolves a const alias of the receiver", () => {
  const code = "const c = navigator.clipboard; c.readText();";
  assert.deepEqual([...scan(code)], ["clipboardRead"]);
});

// Feature-detection (no call) and unrelated methods must NOT ground anything.
test("does not ground a feature-check or an unrelated method", () => {
  assert.equal(scan("if (navigator.clipboard) { doThing(); }").size, 0);
  assert.equal(scan("const x = navigator.clipboard;").size, 0);
  assert.equal(scan("navigator.clipboard.doSomethingElse();").size, 0);
  assert.equal(scan("other.readText();").size, 0);
});

// A dynamic method name cannot be resolved statically, so it grounds nothing.
test("skips a dynamic/computed method name", () => {
  assert.equal(scan("navigator.clipboard[method]();").size, 0);
});

// No signatures, empty code, or a parse error yields an empty set (never throws).
test("returns empty on no signatures or unparsable input", () => {
  assert.equal(scanWebApiCalls("navigator.clipboard.read();", []).size, 0);
  assert.equal(scan("").size, 0);
  assert.equal(scan("const = ;").size, 0);
});
