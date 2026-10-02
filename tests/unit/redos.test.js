// Text the submission controls is never matched with a pattern whose time grows faster
// than its input. An end-anchored run like /[,;:]+$/ is retried from every position inside
// a long run, which is quadratic in it - a crafted manifest.json name or VENDOR token
// stalled a review for minutes. Those sites are plain string code now
// (src/util/text.js trimStartOf / trimEndOf / cutAtFirst, src/lib/util.js isVersion, and a
// few dedicated scans).
//
// Each site is pinned twice:
//  - LINEAR: its adversarial input at 100k characters finishes under a second (the old
//    pattern took seconds to minutes), and doubling the input does not quadruple the time.
//  - IDENTICAL: on seeded pseudo-random short inputs it returns exactly what the old
//    regex returned. The old regexes live only here, as the oracles.
// A new regex on submission text gets a row here.

import { test } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";

import {
  trimStartOf,
  trimEndOf,
  cutAtFirst,
  displayText,
  wrapText,
  replaceSpans,
  replaceQuoted,
  pathTokensEndingIn,
} from "../../src/util/text.js";
import { globMatch } from "../../src/util/files.js";
import {
  isVersion,
  declarationLine,
  tokenLine,
  lineContaining,
  stripVersionSuffix,
} from "../../src/lib/util.js";
import { expandResourcePattern } from "../../src/lib/web-accessible-resources.js";
import { isMinified } from "../../src/lib/minified.js";
import { offFormThunderbird } from "../../src/lib/trademark.js";
import { eolNormalize } from "../../src/normalize/hash.js";
import { readVendorDeclarations } from "../../src/normalize/vendor.js";
import { classifySource } from "../../src/vendor/sources.js";
import { zipHashesUnder } from "../../src/vendor/archive.js";
import { normalizeRef, resolveRef } from "../../src/lib/manifest-refs.js";
import { renderFindings } from "../../src/report/responses.js";

// ---- harness ----

/** Milliseconds `fn` takes. */
function ms(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/**
 * Linear in n: the 100k input finishes under a second, and - where it takes long enough to
 * measure - doubling n does not come close to quadrupling the time.
 * @param {(n: number) => void} run
 */
function assertLinear(run) {
  run(1000); // warm up the code path, so the first timing is not a compile
  const half = ms(() => run(50_000));
  const full = ms(() => run(100_000));
  assert.ok(full < 1000, `100k input took ${full.toFixed(0)} ms`);
  if (full > 50) {
    assert.ok(
      full / Math.max(half, 1) < 3,
      `doubling the input took ${(full / half).toFixed(1)}x as long`
    );
  }
}

/** A seeded generator (mulberry32), so a failing input reproduces. */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` random strings of up to `max` picks from `parts`. */
function samples(parts, count = 2000, max = 12, seed = 1) {
  const next = rng(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    let s = "";
    const len = Math.floor(next() * (max + 1));
    for (let j = 0; j < len; j++) {
      s += parts[Math.floor(next() * parts.length)];
    }
    out.push(s);
  }
  return out;
}

/** Every sample gives the oracle's answer. */
function assertSame(inputs, actual, oracle) {
  for (const input of inputs) {
    assert.deepEqual(
      actual(input),
      oracle(input),
      `differs on ${JSON.stringify(input)}`
    );
  }
}

// ---- the helpers ----

test("trimStartOf / trimEndOf / cutAtFirst at their edges", () => {
  assert.equal(trimEndOf("", ","), "");
  assert.equal(trimEndOf(",,,", ","), "");
  assert.equal(trimEndOf("a,b", ","), "a,b");
  assert.equal(trimEndOf("a,b,,;", ",;"), "a,b");
  assert.equal(trimStartOf("``a`", "`"), "a`");
  assert.equal(cutAtFirst("a?b#c", "?#"), "a");
  assert.equal(cutAtFirst("abc", "?#"), "abc");
  assert.equal(cutAtFirst("", "?#"), "");
});

test("the helpers match the regexes they replace", () => {
  const parts = ["a", "/", ",", ";", ":", ".", "\n", "\\", "?", "#", "(", " "];
  const inputs = samples(parts);
  for (const chars of [",;:", ".,;", "/", "\n", "\\/"]) {
    const run = new RegExp(`[${chars.replace(/[\\\]^-]/g, "\\$&")}]+$`);
    assertSame(
      inputs,
      (s) => trimEndOf(s, chars),
      (s) => s.replace(run, "")
    );
  }
  assertSame(
    inputs,
    (s) => trimStartOf(s, "/"),
    (s) => s.replace(/^\/+/, "")
  );
  // The cut differs from /[?#].*$/ only across a line break, which these values never
  // legitimately hold, so the comparison leaves line breaks out.
  const oneLine = samples(parts.filter((p) => p !== "\n"));
  assertSame(
    oneLine,
    (s) => cutAtFirst(s, "?#"),
    (s) => s.replace(/[?#].*$/, "")
  );
  assertSame(
    oneLine,
    (s) => cutAtFirst(s, "(").trim(),
    (s) => s.replace(/\(.*$/, "").trim()
  );
  // wrapText's trailing trim is the built-in, which uses the same whitespace as \s.
  const spaces = samples(["a", " ", "\t", " ", " ", "　"]);
  assertSame(
    spaces,
    (s) => s.trimEnd(),
    (s) => s.replace(/\s+$/, "")
  );
});

// ---- the sites ----

test("trademark: the allowed form is found in linear time, exactly as before", () => {
  assertLinear((n) => offFormThunderbird(`Thunderbird${" ".repeat(n)}x`));
  const oracle = (s) =>
    /thunderbird/i.test(s) &&
    /thunderbird/i.test(s.replace(/\s+for\s+thunderbird\s*$/i, ""));
  const words = [
    " ",
    "\t",
    "for",
    "FoR",
    "thunderbird",
    "Thunderbird",
    "x",
    "fo",
  ];
  assertSame(samples(words, 3000, 8), offFormThunderbird, oracle);
});

test("versions: isVersion is linear and accepts exactly what the old pattern did", () => {
  assertLinear((n) => isVersion(`1${".1".repeat(n / 2)}!`));
  const VERSION = /^v?\d+(\.\d+)*([.-][0-9a-z.-]+)?$/i;
  const parts = ["v", "V", "1", "0", ".", "-", "a", "Z", "!", "@"];
  assertSame(samples(parts), isVersion, (s) => VERSION.test(s));
});

test("versions: npm and GitHub pins are judged as before", () => {
  const npm = (v) =>
    classifySource(`https://unpkg.com/lib@${encodeURIComponent(v)}/dist/a.js`)
      .pinned;
  assertLinear((n) => npm(`1${".1".repeat(n / 2)}!`));
  const VERSION = /^v?\d+(\.\d+)*([.-][0-9a-z.-]+)?$/i;
  const parts = ["v", "1", "0", ".", "-", "a", "!"];
  assertSame(
    samples(parts).filter((v) => v && v !== "latest"),
    (v) => classifySource(`https://unpkg.com/lib@${v}/dist/a.js`).pinned,
    (v) => VERSION.test(v)
  );
  const GIT_REF = /^(v?\d+(\.\d+)*([.-][0-9a-z.-]+)?|[0-9a-f]{40})$/i;
  const sha = "0123456789abcdef0123456789abcdef01234567";
  for (const ref of [
    sha,
    sha.toUpperCase(),
    `${sha}0`,
    "v1.2.3",
    "main",
    "1",
  ]) {
    assert.equal(
      classifySource(`https://github.com/o/r/blob/${ref}/a.js`).pinned,
      GIT_REF.test(ref),
      ref
    );
  }
});

test("VENDOR tokens: trailing punctuation is trimmed in linear time", () => {
  const addon = (token) => ({
    files: new Map([
      [
        "VENDOR.md",
        Buffer.from(
          `- file: ${token}\n- source: https://unpkg.com/lib@1.0.0/dist/a.js\n`
        ),
      ],
      ["lib/a.js", Buffer.from("1;")],
    ]),
  });
  assertLinear((n) =>
    readVendorDeclarations(addon(`lib/a.js${",".repeat(n)}x`))
  );
  assertLinear((n) =>
    readVendorDeclarations(addon(`lib/a.js${".".repeat(n)}x`))
  );
  // The token still resolves after its decoration comes off.
  assert.deepEqual(
    readVendorDeclarations(addon("`lib/a.js`,;")).resolved.map((e) => e.path),
    ["lib/a.js"]
  );
});

test("hashing: trailing newlines are trimmed in linear time", () => {
  assertLinear((n) => eolNormalize(Buffer.from(`a${"\n".repeat(n)}x`)));
  assertSame(
    samples(["a", "\n", "\r", "\r\n"]),
    (s) => eolNormalize(Buffer.from(s)),
    (s) => s.replace(/\r\n?/g, "\n").replace(/\n+$/, "")
  );
});

test("vendor archives: the subpath's trailing slashes come off in linear time", () => {
  const zip = new AdmZip();
  zip.addFile("repo-ref/sub/a.js", Buffer.from("A\n"));
  const buf = zip.toBuffer();
  assertLinear((n) => zipHashesUnder(buf, `sub${"/".repeat(n)}x`));
  assert.equal(zipHashesUnder(buf, "sub///").size, 1);
});

test("manifest.json references: ?query and #hash are cut in linear time", () => {
  assertLinear((n) => normalizeRef(`a${"?".repeat(n)}\nx`));
  const files = new Map([["a.html", Buffer.from("")]]);
  assertLinear((n) => resolveRef(files, "", `a.html${"#".repeat(n)}\nx`));
  assert.equal(normalizeRef("./page.html?x=1#top"), "page.html");
});

test("lock and package.json lines: a key is located in linear time, exactly as before", () => {
  assertLinear((n) => declarationLine(`a${" ".repeat(n)}b`, "c"));
  // The old chain: a quoted token, else the YAML key line, else any line containing it.
  const oldYamlKeyLine = (text, key) => {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^(['"]?)(.*?)\1\s*:(?:\s|$)/.exec(lines[i].trim());
      if (m && m[2] === key) {
        return i + 1;
      }
    }
    return null;
  };
  const oracle = ([text, key]) =>
    !text || !key
      ? null
      : (tokenLine(text, key) ??
        oldYamlKeyLine(text, key) ??
        lineContaining(text, key));
  const lines = samples(["a", "b", " ", ":", "'", '"', "\t"], 3000, 10);
  const keys = samples(["a", "b", " ", ":", "'"], 3000, 3, 2);
  const pairs = lines.map((line, i) => [`x\n${line}`, keys[i]]);
  assertSame(pairs, ([text, key]) => declarationLine(text, key), oracle);
});

test("filled responses: whitespace around line breaks collapses in linear time", () => {
  const registry = {
    responseFor: () => "Value: {{value}} end",
    collapseOf: () => null,
  };
  const render = (value) => {
    const finding = { ruleId: "x", item: null, data: { value } };
    renderFindings([finding], registry, undefined);
    return finding.message;
  };
  assertLinear((n) => render(`a${" ".repeat(n)}b`));
  const oldCollapse = (s) =>
    s
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/[ \t]+/g, " ")
      .trim();
  assertSame(samples([" ", "\t", "\n", "a"]), render, (value) =>
    oldCollapse(`Value: ${displayText(value)} end`)
  );
});

test("wrapped prose: a long whitespace run is trimmed in linear time", () => {
  assertLinear((n) => wrapText(`a${" ".repeat(n)}b`));
});

test("web_accessible_resources globs: matched in pattern x path time, exactly as before", () => {
  // The old compiled pattern backtracked once per way to split the path between its "**",
  // exponential in their number.
  const files = (n) => new Map([[`${"a".repeat(n)}c`, Buffer.from("")]]);
  assertLinear((n) =>
    expandResourcePattern(files(n / 1000), "**a**a**a**a**a**b")
  );
  assertLinear((n) => globMatch("**a**a**a**a**a**b", `${"a".repeat(n)}c`));
  const oldGlob = (glob) => {
    let re = "^";
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === "*") {
        if (glob[i + 1] === "*") {
          re += ".*";
          i++;
        } else {
          re += "[^/]*";
        }
      } else if (c === "?") {
        re += "[^/]";
      } else {
        re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
    }
    return new RegExp(`${re}$`);
  };
  const globs = samples(["*", "**", "?", "a", "b", "/", ".", "\n"], 400, 6);
  const paths = samples(["a", "b", "/", ".", "\n", " "], 60, 8, 2);
  for (const glob of globs) {
    const re = oldGlob(glob);
    assertSame(
      paths,
      (path) => globMatch(glob, path),
      (path) => re.test(path)
    );
  }
  const packaged = new Map(paths.map((p) => [p, Buffer.from("")]));
  assert.deepEqual(
    expandResourcePattern(packaged, "a/*"),
    [...packaged.keys()].filter((p) => oldGlob("a/*").test(p))
  );
});

test("stylesheets: comments, url() and strings are stripped in linear time, exactly as before", () => {
  // Each unterminated opener sent the old lazy or bounded run to the end of the text, once
  // per opener.
  const css = (opener) => (n) =>
    isMinified(`a{${opener.repeat(n / opener.length)}}`, "a.css");
  for (const opener of ["/*", "url(", '"', "'", '"\\', "URL("]) {
    assertLinear(css(opener));
  }
  const parts = [
    "/",
    "*",
    '"',
    "'",
    "\\",
    "(",
    ")",
    "u",
    "r",
    "l",
    "U",
    "a",
    "\n",
    "\r",
  ];
  const inputs = samples(parts, 4000, 14);
  assertSame(
    inputs,
    (s) => replaceSpans(s, "/*", "*/", ""),
    (s) => s.replace(/\/\*[\s\S]*?\*\//g, "")
  );
  assertSame(
    inputs,
    (s) => replaceSpans(s, "url(", ")", "url()", { caseInsensitive: true }),
    (s) => s.replace(/url\([^)]*\)/gi, "url()")
  );
  assertSame(
    inputs,
    (s) => replaceQuoted(s, '"'),
    (s) => s.replace(/"(?:[^"\\]|\\.)*"/g, '""')
  );
  assertSame(
    inputs,
    (s) => replaceQuoted(s, "'"),
    (s) => s.replace(/'(?:[^'\\]|\\.)*'/g, "''")
  );
  // Through the caller: a line that is long only because of a payload is not minified.
  const payload = "x".repeat(600);
  assert.equal(isMinified(`a{b:url(${payload})}`, "a.css"), false);
  assert.equal(isMinified(`a{b:"${payload}"}`, "a.css"), false);
  assert.equal(isMinified(`/*${payload}*/`, "a.css"), false);
  assert.equal(isMinified(`a{b:c}`.repeat(120), "a.css"), true);
});

test("mentions: path tokens ending in a basename are found in linear time, exactly as before", () => {
  // A long run of path characters without the basename was rescanned from each position.
  assertLinear((n) => pathTokensEndingIn(`${"a".repeat(n)}x.js`, "b.js"));
  assertLinear((n) => pathTokensEndingIn(`${"a.js".repeat(n / 4)}`, "a.js"));
  const parts = ["a", "b", ".", "/", "-", "@", "_", " ", "(", "'", "ab", "b.a"];
  const lines = samples(parts, 3000, 12);
  for (const base of ["a", "ab", "b.a", "a.a"]) {
    const re = new RegExp(`[\\w./@-]*${base.replace(/\./g, "\\.")}`, "g");
    assertSame(
      lines,
      (line) => pathTokensEndingIn(line, base),
      (line) => [...line.matchAll(re)].map((m) => m[0])
    );
  }
});

test("CDN file names: the version tail comes off in linear time, exactly as before", () => {
  assertLinear((n) => stripVersionSuffix(`a${".1".repeat(n / 2)}x`));
  assertLinear((n) => stripVersionSuffix(`a${"-1".repeat(n / 2)}`));
  const parts = ["a", "v", "1", "0", ".", "-", "_"];
  assertSame(samples(parts, 4000, 12), stripVersionSuffix, (s) =>
    s.replace(/[-_.]v?\d+(\.\d+)*$/, "")
  );
});
