// Unit tests for the extension-file reader (parseExtensionJson): it must accept exactly what
// Thunderbird's extension loader reads - JSON with `//` comments removed - and refuse the
// rest, since a manifest.json the application will not load must not review clean.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseExtensionJson,
  decodeExtensionText,
} from "../../src/util/json.js";
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
      directories: ["_locales", "_locales/de", "_locales/en"],
    },
  };
  const { pairs, unreadable } = localizedNames(ctx);
  assert.deepEqual(pairs, [{ locale: "en", name: "Mail Helper" }]);
  assert.deepEqual(unreadable, ["de"]);
});

// Bytes are decoded as Gecko decodes them: a byte-order mark is sniffed (UTF-16 either way
// round, a UTF-8 one dropped), and otherwise UTF-8 with no replacement - one invalid byte
// refuses the whole file.
test("files are decoded as Thunderbird decodes them", () => {
  const json = '{"a": "\u00e9"}';
  const le = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(json, "utf16le"),
  ]);
  const be = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from(json, "utf16le").swap16(),
  ]);
  const utf8Bom = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(json),
  ]);
  for (const bytes of [le, be, utf8Bom, Buffer.from(json)]) {
    assert.deepEqual(parseExtensionJson(bytes), { a: "\u00e9" });
  }
  // "Caf\xe9": Latin-1, not UTF-8.
  const latin1 = Buffer.from([
    0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe9, 0x22, 0x7d,
  ]);
  assert.equal(decodeExtensionText(latin1), undefined);
  assert.equal(parseExtensionJson(latin1), undefined);
});

// Gecko reads the file in one pass that never flushes: an incomplete sequence at the very
// end is dropped, not refused. And it drops ONE byte-order mark: a second is text, which
// JSON.parse refuses.
test("an incomplete tail is dropped, and only one BOM", () => {
  const json = Buffer.from('{"a": "x"}');
  assert.deepEqual(
    parseExtensionJson(Buffer.concat([json, Buffer.from([0xc3])])),
    {
      a: "x",
    }
  );
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('{"a": "x"}', "utf16le"),
    Buffer.from([0x00]),
  ]);
  assert.deepEqual(parseExtensionJson(utf16), { a: "x" });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  assert.equal(parseExtensionJson(Buffer.concat([bom, bom, json])), undefined);
  assert.equal(parseExtensionJson('\uFEFF\uFEFF{"a": 1}'), undefined);
});
