// Unit tests for the extension-file reader (parseExtensionJson): it must accept exactly what
// Thunderbird's extension loader reads - JSON with `//` comments removed - and refuse the
// rest, since a manifest.json the application will not load must not review clean.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseExtensionJson,
  parseJsonc,
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

// A __MSG_ name is looked up as Thunderbird looks it up: names are case-insensitive, and of
// two that differ only in case the later one is the one it keeps.
test("a __MSG_ name is resolved case-insensitively", () => {
  const ctx = {
    manifest: { json: { name: "__MSG_appName__" } },
    artifact: {
      files: new Map([
        [
          "_locales/en/messages.json",
          Buffer.from('{"APPNAME": {"message": "Mail Helper"}}'),
        ],
        [
          "_locales/de/messages.json",
          Buffer.from(
            '{"appname": {"message": "first"}, "AppName": {"message": "second"}}'
          ),
        ],
      ]),
      directories: ["_locales", "_locales/de", "_locales/en"],
    },
  };
  assert.deepEqual(localizedNames(ctx).pairs, [
    { locale: "de", name: "second" },
    { locale: "en", name: "Mail Helper" },
  ]);
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

// parseJsonc reads a bun.lock the way Bun does: JSON with trailing commas and comments, which
// JSON.parse refuses. Measured against Bun 1.4.4: it installs from a lock carrying `//` and
// `/* */` comments, and refuses a comma that follows no value ("Ignoring lockfile").
test("parseJsonc accepts trailing commas and comments, and nothing else JSON refuses", () => {
  assert.deepEqual(parseJsonc('{"a": [1, 2,], "b": {"c": 3,},}'), {
    a: [1, 2],
    b: { c: 3 },
  });
  assert.deepEqual(parseJsonc('{\n  // line\n  "a": 1, /* block */\n}'), {
    a: 1,
  });
  assert.deepEqual(parseJsonc('{"a": 1 /* x */ ,\n /* y */ }'), { a: 1 });
  // Commas, comment markers and brackets inside strings are text.
  assert.deepEqual(
    parseJsonc('{"u": "https://x//y", "v": ",]", "w": "a\\"b,}",}'),
    {
      u: "https://x//y",
      v: ",]",
      w: 'a"b,}',
    }
  );
  // A BOM, as for every other file parsed here.
  assert.deepEqual(parseJsonc('\ufeff{"a": 1,}'), { a: 1 });
  // A comma after an opening bracket or another comma trails nothing.
  for (const bad of ["[,]", "{,}", "[1,,]", '{"a": 1,,}']) {
    assert.equal(parseJsonc(bad), null, bad);
  }
  // What JSON itself refuses stays refused, and so does an unterminated comment or string.
  for (const bad of [
    "{a: 1}",
    "{'a': 1}",
    '{"a": 1',
    '{"a": 1} /* open',
    '{"a": "x}',
  ]) {
    assert.equal(parseJsonc(bad), null, bad);
  }
  assert.equal(parseJsonc(""), null);
  assert.equal(parseJsonc(null), null);
  assert.deepEqual(parseJsonc(Buffer.from('{"a": 1,}')), { a: 1 });
});

// Bun reads the FIRST of two same-named members, JSON.parse the last - measured: a bun.lock
// with two `packages` maps installs from the first. So a text naming a key twice, anywhere,
// cannot be read: reading it would audit a tree the install never builds.
test("parseJsonc refuses a duplicate key at any depth", () => {
  assert.equal(parseJsonc('{"packages": {}, "packages": {"ms": 1},}'), null);
  assert.equal(parseJsonc('{"a": {"b": 1, "b": 2}}'), null);
  // The same key in two different objects is no duplicate.
  assert.deepEqual(parseJsonc('[{"a": 1}, {"a": 2},]'), [{ a: 1 }, { a: 2 }]);
  // "__proto__" is a key like any other, as JSON.parse reads it.
  const proto = parseJsonc('{"__proto__": {"x": 1},}');
  assert.deepEqual(Object.keys(proto), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
});

// Bun's lexer ends a `//` comment at a line feed or a carriage return (measured: it installs
// from a lock whose comment ends at CR), and a comment separates the tokens on either side, so
// `1/**/2` is two numbers, which Bun refuses. Bun also ends a comment at a Unicode line
// separator, which jsonc-parser does not: such a lock is refused, never misread.
test("parseJsonc ends a comment where Bun does, and keeps tokens apart", () => {
  for (const end of ["\n", "\r"]) {
    assert.deepEqual(
      parseJsonc(`{"a": 1, // c${end}"b": 2,}`),
      { a: 1, b: 2 },
      JSON.stringify(end)
    );
  }
  assert.equal(parseJsonc('{"a": 1, // c\u2028"b": 2,}'), null);
  // Even where the rest still parses: jsonc-parser would drop "evil", which Bun reads.
  assert.equal(parseJsonc('{"a": 1, // c\u2028"evil": 2,\n"b": 3,}'), null);
  assert.equal(parseJsonc('{"a": 1, // c\u2029"evil": 2,\n"b": 3,}'), null);
  // A separator inside a string is text.
  assert.deepEqual(parseJsonc('{"a": "x\u2028y",}'), { a: "x\u2028y" });
  assert.equal(parseJsonc('{"a": 1/**/2}'), null);
  assert.equal(parseJsonc('{"a": 1//c\n2}'), null);
});
