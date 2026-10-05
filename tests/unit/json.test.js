// Unit tests for the extension-file reader (parseExtensionJson): it must accept exactly what
// Thunderbird's extension loader reads - JSON with `//` comments removed - and refuse the
// rest, since a manifest.json the application will not load must not review clean.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseExtensionJson } from "../../src/util/json.js";
import { localizedNames } from "../../src/lib/locales.js";

test("parseExtensionJson accepts `//` comments wherever Thunderbird does", () => {
  assert.deepEqual(parseExtensionJson('// header\n{"a": 1}'), { a: 1 });
  assert.deepEqual(parseExtensionJson('{"a": 1, // after a value\n "b": 2}'), {
    a: 1,
    b: 2,
  });
  assert.deepEqual(parseExtensionJson('{"a": 1}\n// at the very end'), {
    a: 1,
  });
  // A `//` inside a string is text, an escaped quote does not end the string.
  assert.deepEqual(
    parseExtensionJson(
      '{"u": "https://x.example/a", "q": "say \\"//\\" here"}'
    ),
    { u: "https://x.example/a", q: 'say "//" here' }
  );
  // A BOM, as packaging tools write it.
  assert.deepEqual(parseExtensionJson('\uFEFF{"a": 1}'), { a: 1 });
  assert.deepEqual(parseExtensionJson(Buffer.from('{"a": 1}')), { a: 1 });
});

test("parseExtensionJson refuses everything else JSON5 would allow", () => {
  for (const text of [
    '{"a": 1, /* block */ "b": 2}',
    '{"a": 1} /',
    '{"a": 1,}',
    "{a: 1}",
    "{'a': 1}",
    '{"a": "never ends}',
    "",
  ]) {
    assert.equal(parseExtensionJson(text), undefined, text);
  }
  assert.equal(parseExtensionJson(null), undefined);
});

// A JSON text may be `null` - it parses, and is simply not an object. Undefined is the
// failure value, so a manifest.json holding `null` is "not a manifest", not "unreadable".
test("parseExtensionJson answers null for the JSON text null", () => {
  assert.equal(parseExtensionJson("null"), null);
});

// The localized-name reader uses the same rule: a messages.json Thunderbird would read
// states its name, one it would refuse is reported as unreadable rather than skipped.
test("a messages.json is read as Thunderbird reads it", () => {
  const ctx = {
    manifest: { json: { name: "__MSG_appName__" } },
    artifact: {
      files: new Map([
        [
          "_locales/en/messages.json",
          Buffer.from(
            '// strings\n{"appName": {"message": "Mail Helper"}} // done'
          ),
        ],
        [
          "_locales/de/messages.json",
          Buffer.from('{"appName": {"message": "x"},}'),
        ],
      ]),
    },
  };
  const { pairs, unreadable } = localizedNames(ctx);
  assert.deepEqual(pairs, [{ locale: "en", name: "Mail Helper" }]);
  assert.deepEqual(unreadable, ["de"]);
});
