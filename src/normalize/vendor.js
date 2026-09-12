// Parses the add-on's VENDOR file (developers list every bundled third-party
// library there so reviewers can verify it matches upstream). Those files must
// stay byte-for-byte identical to the release they came from, so the normalizer
// skips any path listed here, and vendor verification fetches the declared
// source to confirm it (src/vendor/verify.js).
//
// The grammar is deliberately narrow, because the cost of reading too much is not a
// parse error - it is a WRONG declaration that looks right. A file and a URL pair only
// where the developer MARKED the pairing: a colon, a key, or Markdown link syntax -
// or, on one line, the two standing alone together with both halves anchored. What is
// never inferred is the PATH half, so a path named inside a sentence stays a sentence.
//
// A block is one declaration and may not contain a blank line. A blank line ends it, a
// heading or thematic break starts a new one, and a dedent ends it - which is what
// separates entries in a nested list written with no blank lines between them.
//
// The file is read whole and any fault discards ALL of it, so the developer is told
// their VENDOR file is unparseable (and the LLM fallback in src/vendor/resolve.js gets
// the text) instead of the review proceeding on half a manifest. Half a manifest is the
// worse outcome by far: the declarations that were missed simply look undeclared, and
// come back to the developer as "undeclared third-party library" for a library they
// did declare, with nothing pointing at the file that says so.
//
// What a shipped VENDOR file may look like is in
// https://webextension-api.thunderbird.net/en/mv3/guides/vendoring.html, and the
// unparseable finding quotes the accepted shapes (assets/registry.yaml).
//
// Belongs here: the deterministic VENDOR parse only - locating the file
// (readVendorFile), the packaged-file matcher (buildFileMatcher), the
// {path, sourceUrl} extraction (parseVendorManifest), and the entries whose
// declared file is absent (missingVendorEntries). It is LLM-free and pure.
//
// Does NOT belong here: the LLM parse fallback and the canonical resolved set
// (-> src/vendor/resolve.js). Nor any verdict about what was parsed: ONE source
// covering several files is reported faithfully here and judged by
// vendor-ambiguous-source. The consumers of the set: prettyprint.js skips
// vendored files from reformatting, bundled.js skips them from scanning, and
// unused-files exempts them. Fetching/verifying the declared source is the
// vendor verification pre-step + the vendor checks. This file makes no verdict.

import { basename } from "../util/files.js";

/** @typedef {import("../addon/load.js").Addon} Addon */
/** @typedef {{path: string, sourceUrl: ?string, kind?: string}} VendorEntry */

// VENDOR filenames developers use (matched case-insensitively).
const VENDOR_NAMES = new Set(["vendor", "vendor.md", "vendors", "vendors.md"]);

/**
 * Every packaged file whose name says it is the VENDOR manifest, sorted so the answer
 * does not depend on the order the archive happens to list them in. More than one is
 * a contradiction only the developer can settle - see multiple-vendor-files.
 * @param {Addon} addon
 * @returns {string[]}
 */
export function vendorFileNames(addon) {
  const files = addon?.files;
  return files
    ? [...files.keys()].filter((f) => VENDOR_NAMES.has(f.toLowerCase())).sort()
    : [];
}

/**
 * The add-on's VENDOR file, or null when there is none - and null when there is more
 * than one, because choosing between them would mean reviewing against a manifest the
 * developer may not have meant. multiple-vendor-files reports that; nothing here
 * treats an ambiguous manifest as readable.
 * @param {Addon} addon
 * @returns {?{name: string, text: string}}
 */
export function readVendorFile(addon) {
  const names = vendorFileNames(addon);
  if (names.length !== 1) {
    return null;
  }
  const [name] = names;
  const files = addon.files;
  // A leading BOM is how the file was SAVED, not part of what it says - and it must
  // come off before the character rule below, since U+FEFF is itself a format
  // character and would otherwise refuse every file a Windows editor wrote.
  const text = files
    .get(name)
    .toString("utf8")
    .replace(/^\uFEFF/, "");
  return { name, text };
}

/**
 * Normalize a free-form token: trim, strip surrounding quotes and trailing
 * punctuation, fold Windows "\" separators, drop a leading "./" and a trailing "/".
 * @param {string} token
 * @returns {string}
 */
function normalizeToken(token) {
  return (
    String(token)
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "") // strip surrounding quotes / Markdown backticks
      .replace(/[,;:]+$/g, "")
      .replace(/\\/g, "/")
      .replace(/^\.?\//, "")
      // A trailing slash spells a directory, it does not name a different one. Every
      // consumer builds `${path}/` to prefix-match under it, so leaving the slash on
      // yields "lib/vendor//" and matches nothing: the folder reads as not shipped,
      // and its files lose the vendored exemption.
      .replace(/\/+$/, "")
  );
}

// Any extension - a loose "could name a file" gate (so a real ".7z" still
// matches). A letter-led extension (.js, .css, .min.js) is the stricter gate for
// picking a MISSING candidate, so a version token like "2.2.1" is not mistaken
// for a filename.
const LOOSE_EXT = /\.[a-z0-9]+$/i;
const STRONG_EXT = /\.[a-z][a-z0-9]*$/i;

/**
 * A matcher resolving a free-form token to a packaged add-on path, or null: by exact
 * posix path or an unambiguous basename, normalizing "\\" separators, surrounding
 * quotes and trailing punctuation. Used to validate an LLM-suggested path, so a
 * hallucinated file is dropped. The deterministic parse does NOT use it - a
 * declaration written by hand is a path, matched exactly (resolveDeclarations).
 * @param {Addon} addon
 * @returns {(token: string) => ?string}
 */
export function buildFileMatcher(addon) {
  const paths = new Set(addon.files.keys());
  const byBase = new Map();
  for (const p of addon.files.keys()) {
    const b = basename(p);
    byBase.set(b, [...(byBase.get(b) ?? []), p]);
  }
  return (token) => {
    const norm = normalizeToken(token);
    if (paths.has(norm)) {
      return norm;
    }
    const hits = byBase.get(basename(norm));
    return hits && hits.length === 1 ? hits[0] : null;
  };
}

// Code-hosting roots: github.com/owner/repo (<= 2 path segments) is a repository,
// not a file, even when the repo name ends in ".js" - so it is never a source URL.
const REPO_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "sourceforge.net",
]);

/**
 * Whether a URL points to a fetchable FILE (so a bare repository link is not a
 * source): its last path segment has a file extension, and it is not a code-host
 * repository root. CDN / registry / raw URLs pass; an untrusted-but-file URL also
 * passes (so resolve.js can still flag it "untrusted host").
 * @param {string} url
 * @returns {boolean}
 */
function pointsToFile(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const segs = u.pathname.split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  if (!LOOSE_EXT.test(last)) {
    return false; // no filename/extension - a page or repo root
  }
  return !(REPO_HOSTS.has(u.hostname.toLowerCase()) && segs.length <= 2);
}

/**
 * Whether a URL points to a DIRECTORY we can resolve to a fetchable archive (so a
 * folder declaration can be verified): a github `…/tree/<ref>/<path>` URL. The
 * source classifier (src/vendor/sources.js) maps it to the repo ZIP + the subpath.
 * A bare repo root is not a directory source.
 * @param {string} url
 * @returns {boolean}
 */
function isDirSource(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const segs = u.pathname.split("/").filter(Boolean);
  return (
    u.hostname.toLowerCase() === "github.com" &&
    segs[2] === "tree" &&
    segs.length >= 4
  );
}

// The keys that name the packaged file of a declaration, and the ones that name its
// upstream source. Matched case-insensitively with runs of whitespace folded, so
// "Bundled File" and "bundled  file" are the same key.
const FILE_KEYS = new Set([
  "file",
  "bundled file",
  "distributed file",
  "included file",
]);
// A declaration covering a whole directory. Which kind a declaration is comes from
// the KEY the developer chose, not from looking the token up in the package - the
// parser reads the file, it does not consult the submission.
const FOLDER_KEYS = new Set(["folder", "bundled directory", "directory"]);
const SRC_KEYS = new Set([
  "source",
  "url",
  "source file",
  "source url",
  "upstream",
  "source directory",
  "link",
]);

// [path](url), the Markdown link spelling of a one-line declaration.
// Not anchored at the end: the link is the declaration and whatever follows it is
// prose about the declaration, the same rule the other two one-line spellings use.
const MD_LINK_RE = /^\[([^\]]+)\]\(\s*<?([^)\s>]+)>?\s*\)/;
// A path may hold only these characters. Decoration is stripped in MATCHED pairs, so
// a leftover bracket or quote means the token was never a path ("[lib/x.js" is
// malformed, not a declaration) - which matters because the packaged-file lookup
// falls back to the basename and would otherwise resolve it.
const PATH_CHARS = /^[A-Za-z0-9._/\\@+-]+$/;

/**
 * Does this token look like a path to a file? Shape only: the allowed characters,
 * and a letter-led extension so a version ("2.2.1") is not read as a filename.
 * Whether the submission HOLDS it is a later question - the parser reads the VENDOR
 * file, it does not consult the package.
 * @param {string} token
 * @returns {boolean}
 */
function isPathToken(token) {
  return Boolean(token) && PATH_CHARS.test(token) && STRONG_EXT.test(token);
}

// A list marker opening a line: "- ", "* ", "+ ", "1. ", "1) ".
const BULLET_RE = /^(?:[-*+]\s+|\d+[.)]\s+)/;

/**
 * Move a colon that sits INSIDE a bold key out of it: `**Source:**` reads as
 * `**Source**:`. Markdown authors write it both ways, and without this the key is
 * unreadable and its value - usually the source URL - is never seen at all.
 *
 * Deliberately not a regular expression. The obvious pattern for it puts a class
 * that matches spaces next to `\s*`, and the two then share any run of whitespace -
 * which is a quadratic number of ways to fail on input that ships inside the
 * submission. Three indexOf calls cannot backtrack.
 * @param {string} line
 * @returns {string}
 */
function foldBoldKeyColon(line) {
  const open = line.indexOf("**");
  if (open < 0) {
    return line;
  }
  const close = line.indexOf("**", open + 2);
  if (close < 0) {
    return line;
  }
  const key = line.slice(open + 2, close).trimEnd();
  if (!key.endsWith(":")) {
    return line;
  }
  const name = key.slice(0, -1).trimEnd();
  return name
    ? `${line.slice(0, open + 2)}${name}**:${line.slice(close + 2)}`
    : line;
}

/**
 * Strip MATCHED decoration pairs - `x`, **x**, [x], <x>, "x", 'x' - repeatedly, then
 * trailing sentence punctuation. Only matched pairs come off. The single place that
 * decides how a token reads once its Markdown dress is removed, so the one-line, the
 * keyed and the header spellings cannot disagree about what a path or a URL is.
 * @param {string} token
 * @returns {string}
 */
function undecorate(token) {
  let t = String(token).trim();
  let prev;
  do {
    prev = t;
    t = t.replace(/[.,;]+$/, "");
    // `**` is the one pair that can nest - the others' inner classes exclude their
    // own closer. Taking every layer in one walk is what keeps this loop from
    // rescanning the whole token once per layer.
    let a = 0;
    let b = t.length;
    while (b - a > 4 && t.startsWith("**", a) && t.startsWith("**", b - 2)) {
      a += 2;
      b -= 2;
    }
    if (a) {
      t = t.slice(a, b);
    }
    t = t
      .replace(/^`([^`]+)`$/, "$1")
      .replace(/^\[([^\]]+)\]$/, "$1")
      .replace(/^<([^>]+)>$/, "$1")
      .replace(/^"([^"]+)"$/, "$1")
      .replace(/^'([^']+)'$/, "$1")
      .trim();
  } while (t !== prev);
  return t;
}

/**
 * Split a line into its key and value at the FIRST colon, or null when it carries
 * none. The leading bullet goes, and the key is undecorated like every other token -
 * so all six decoration pairs read alike, rather than the two a pattern could
 * describe inline.
 *
 * Deliberately not a regular expression, for the reason given on foldBoldKeyColon:
 * describing "optional whitespace around the colon" next to a key class that also
 * matches whitespace is what makes such a pattern quadratic.
 * @param {string} line
 * @returns {?{key: string, value: string}}
 */
function splitKeyValue(line) {
  const t = line.trim().replace(BULLET_RE, "");
  const i = t.indexOf(":");
  if (i < 0) {
    return null;
  }
  const key = undecorate(t.slice(0, i).trimEnd());
  return key ? { key, value: t.slice(i + 1).trim() } : null;
}

/**
 * The path a value names: a backticked span when there is one (the rest of the value
 * is then prose about it - "`vendor/ical.js` (UMD build)"), else the value's FIRST
 * token undecorated. Only the first token, because whatever follows is prose.
 * @param {string} value
 * @returns {string}
 */
function pathToken(value) {
  const t = String(value).trim();
  const span = t.match(/^`([^`]+)`/);
  return span ? span[1].trim() : undecorate(t.split(/\s+/)[0] ?? "");
}

/**
 * The source URL a value names, or null: its FIRST token, undecorated (so a Markdown
 * autolink and a trailing comma come off), and only when that is a URL pointing at a
 * fetchable file or a resolvable directory. A bare repository link is not a source.
 * @param {string} value
 * @returns {?string}
 */
function sourceToken(value) {
  const t = undecorate(String(value).trim().split(/\s+/)[0] ?? "");
  if (!/^https?:\/\//i.test(t)) {
    return null;
  }
  return pointsToFile(t) || isDirSource(t) ? t : null;
}

// Control and format characters a plain list of files and URLs has no use for. Tab,
// CR and LF are the only three that belong in a text file; the rest are invisible or
// are instructions to a terminal - an escape sequence can repaint the report around a
// finding, and a bidi override can make a path read as something it is not. A file
// carrying any of them is not the text it appears to be, so none of it is read.
const FORBIDDEN_CHAR = /(?![\t\r\n])[\p{Cc}\p{Cf}]/u;

// One declaration does not run to a hundred lines. Past that the block is not a
// declaration with notes under it, and reading it as one is how a single block came
// to hold enough one-line declarations to overflow the stack when its records were
// spread into the file's list.
const MAX_BLOCK_LINES = 100;

/**
 * Split the VENDOR text into blocks. A block is a run of lines that belong to ONE
 * declaration, and it may not contain a blank line: a blank line always ends it, a
 * Markdown heading or thematic break starts a new one, and a DEDENT ends it too -
 * which is what separates entries in a nested list written with no blank lines
 * between them.
 * @param {string} text
 * @returns {string[][]}
 */
function splitBlocks(text) {
  const blocks = [];
  let cur = [];
  const indentOf = (line) => line.match(/^\s*/)[0].length;
  const flush = () => {
    if (cur.length) {
      blocks.push(cur);
      cur = [];
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*$/.test(line)) {
      flush();
      continue;
    }
    if (
      /^\s{0,3}#{1,6}\s/.test(line) ||
      /^\s{0,3}([-*_])\1{2,}\s*$/.test(line)
    ) {
      flush();
      continue;
    }
    if (cur.length && indentOf(line) < indentOf(cur[cur.length - 1])) {
      flush();
    }
    cur.push(line);
  }
  flush();
  return blocks;
}

/**
 * The declaration a single line makes on its own, or null. Three spellings, all
 * requiring the two halves to be ADJACENT so nothing has to be inferred from
 * proximity: `[path](url)`, `path: url` and `path url`. Only the first two tokens
 * are read - a trailing note ("(unmodified)", "built from Release 1.0.0") is prose
 * about the declaration, not part of it.
 *
 * Both halves are anchored by SHAPE: the first token must look like a path and the
 * second must be a URL naming a file. Whether the package holds that path is not
 * asked here - a repository link whose slug ends in ".js" is turned away by its URL
 * being a repo root, not by looking the slug up.
 * @param {string} line
 * @returns {?{token: string, kind: string, sourceUrl: string}}
 */
function oneLineDeclaration(line) {
  const t = line.trim().replace(BULLET_RE, "");
  const link = t.match(MD_LINK_RE);
  const pair = link
    ? [link[1], link[2]]
    : (t.match(/^(\S+?)\s*:\s*(\S+)/) ?? t.match(/^(\S+)\s+(\S+)/))?.slice(1);
  if (!pair) {
    return null;
  }
  const token = undecorate(pair[0]);
  const url = sourceToken(pair[1]);
  return url && isPathToken(token)
    ? { token, kind: "file", sourceUrl: url }
    : null;
}

/**
 * Read one block into the declaration it makes, or reject it. A block is EITHER a run
 * of self-contained one-line declarations, OR one keyed declaration: the packaged file
 * (a FILE_KEYS key, or a "path:" header line) and its source (a SRC_KEYS key, else the
 * first file URL the block carries).
 *
 * Anything else is rejected rather than guessed at - a block naming a file with no
 * source, a source with no file, two sources, two files, or one-liners mixed with
 * keyed lines. A "path:" header beside a file key is NOT a contradiction: the header
 * is the block's label and the key is the authority, so the key wins. One source covering several files is still a real declaration shape,
 * written as one block per file citing the same URL; those pair faithfully here and
 * vendor-ambiguous-source in resolveVendor is the layer that judges them.
 * Reports every source URL it recognised alongside the records, so the caller can
 * tell a URL that became a declaration from one that did not. Those URLs come from
 * sourceToken like every other, which is the point: the completeness check must not
 * re-derive URLs from the raw text with rules of its own, or the two readings drift
 * apart and the check starts judging strings the parser never saw.
 * @param {string[]} block
 * @returns {{records: object[], rejected: boolean, urls: string[]}}
 */
function readBlock(block) {
  const oneLiners = [];
  const seenUrls = [];
  const files = [];
  let folder = null;
  let header = null;
  const sources = [];
  const unkeyed = [];
  let malformed = false;
  // The block headed itself with a label. A label promises key:value lines beneath
  // it, so a labelled block never takes its source from a URL standing on its own
  // line - with or without the label's trailing colon, which decides nothing.
  let labelled = false;

  for (const [i, raw] of block.entries()) {
    const line = foldBoldKeyColon(raw);
    const one = oneLineDeclaration(line);
    if (one) {
      oneLiners.push(one);
      seenUrls.push(one.sourceUrl);
      continue;
    }
    const bare = sourceToken(line.trim());
    if (bare) {
      unkeyed.push(bare);
      seenUrls.push(bare);
      continue;
    }
    const kv = splitKeyValue(line);
    if (!kv) {
      // A block may head itself with the library's name, which is often the
      // packaged path and often carries no colon. ONLY the first line: anywhere
      // else a lone path is prose - a "runtime consumers" list, a "see also" - and
      // reading those as declarations is the mistake this grammar exists to avoid.
      if (i === 0) {
        const label = undecorate(line.trim().replace(BULLET_RE, ""));
        if (isPathToken(label)) {
          header = label;
          labelled = true;
        }
      }
      continue;
    }
    const key = kv.key.toLowerCase().replace(/\s+/g, " ");
    const value = kv.value;
    if (FILE_KEYS.has(key) || FOLDER_KEYS.has(key)) {
      const token = pathToken(value);
      // One block declares ONE item, so a second file key - or a file key beside a
      // folder - is the developer saying two things in one place, and choosing
      // between them is not ours to do. A "path:" header is NOT such a second
      // thing: a block may head itself with the library's name, which often looks
      // like a filename, and an explicit file key beside it is the authority.
      if (files.length || folder !== null) {
        malformed = true;
      }
      if (FOLDER_KEYS.has(key)) {
        if (PATH_CHARS.test(token)) {
          folder = token;
        } else {
          malformed = true;
        }
      } else if (isPathToken(token)) {
        files.push({ token });
      } else {
        malformed = true; // a file key naming something that is not a path
      }
      continue;
    }
    if (SRC_KEYS.has(key)) {
      const url = sourceToken(value);
      if (url) {
        sources.push(url);
        seenUrls.push(url);
      }
      continue;
    }
    if (!value) {
      const token = kv.key;
      if (isPathToken(token)) {
        // Two headers name two items; a header over a folder declaration is a
        // contradiction. A header over a file KEY is neither - see above.
        if (header !== null || folder !== null) {
          malformed = true;
        }
        header = token; // a "path:" header line
        labelled = true;
      }
      continue;
    }
    // An unrecognized key LABELS its value as something other than the source -
    // a licence, a homepage, a project page. Its URL is a citation, so it is
    // neither a source candidate nor something a declaration must claim. Only a
    // source key, or a URL standing on its own line with no key at all, can
    // source a declaration.
  }

  // The source: a keyed one wins; failing that the block's only file URL. More than
  // one candidate is ambiguous, and ambiguity is a rejection, not a choice.
  // A keyed source wins; failing that the block's only bare URL line. A LABELLED
  // block forgoes that fallback: it promised key:value lines, so the only shape
  // left for the bare-URL fallback is a block that named its file with a key.
  const fallback = labelled ? [] : unkeyed;
  const source = sources.length
    ? sources[0]
    : fallback.length === 1
      ? fallback[0]
      : null;
  const tooManySources =
    sources.length > 1 || (!sources.length && fallback.length > 1);
  const declaresFile = files.length > 0 || folder !== null || header !== null;

  if (oneLiners.length) {
    // A one-liner says everything itself, so a keyed half in the same block belongs
    // to no declaration - the block is not saying one thing.
    const mixed = declaresFile || sources.length > 0 || unkeyed.length > 0;
    return { records: oneLiners, rejected: mixed || malformed, urls: seenUrls };
  }
  if (malformed || tooManySources) {
    return { records: [], rejected: true, urls: seenUrls };
  }
  if (!declaresFile && !source) {
    return { records: [], rejected: false, urls: seenUrls }; // prose: says nothing, claims nothing
  }
  if (!declaresFile || !source) {
    return { records: [], rejected: true, urls: seenUrls }; // half a declaration
  }
  if (folder !== null) {
    if (files.length) {
      return { records: [], rejected: true, urls: seenUrls }; // a folder AND files: which is it?
    }
    return {
      records: [{ token: folder, kind: "folder", sourceUrl: source }],
      rejected: false,
      urls: seenUrls,
    };
  }
  const named = files.length ? files : [{ token: header }];
  return {
    records: named.map((f) => ({
      token: f.token,
      kind: "file",
      sourceUrl: source,
    })),
    rejected: false,
    urls: seenUrls,
  };
}

/**
 * The declarations a VENDOR file makes, with each path AS WRITTEN. Nothing here
 * consults the submission: resolving a declared path against the packaged files is
 * resolveDeclarations, one step later, so a path the add-on does not hold is
 * REPORTED as missing rather than quietly failing to parse.
 * @param {Addon} addon
 * @returns {{token: string, kind: ?string, sourceUrl: ?string}[]}
 */
function scanVendorRecords(addon) {
  const vendor = readVendorFile(addon);
  if (!vendor) {
    return [];
  }
  if (FORBIDDEN_CHAR.test(vendor.text)) {
    return [];
  }
  const records = [];
  const urls = [];
  let rejected = false;
  for (const block of splitBlocks(vendor.text)) {
    if (block.length > MAX_BLOCK_LINES) {
      return [];
    }
    const out = readBlock(block);
    rejected = rejected || out.rejected;
    records.push(...out.records);
    urls.push(...out.urls);
  }
  const claimed = new Set(records.map((r) => r.sourceUrl));
  if (urls.some((u) => !claimed.has(u))) {
    rejected = true;
  }
  // One file, one source. A path declared twice with DIFFERENT sources is a
  // contradiction only the developer can settle: whichever we kept, the other would
  // never be verified and they would not be told which. Stating one origin twice is
  // no contradiction, so an identical repeat collapses (resolveDeclarations).
  const sourceOf = new Map();
  for (const r of records) {
    const path = normalizeToken(r.token);
    if (sourceOf.has(path) && sourceOf.get(path) !== r.sourceUrl) {
      rejected = true;
      break;
    }
    sourceOf.set(path, r.sourceUrl);
  }
  return rejected ? [] : records;
}

/**
 * Match each declared path against the submission, exactly, from the package root.
 * A declaration is a PATH: a bare filename that is not at the root does not name a
 * packaged file, and is reported missing rather than hunted for by basename. A
 * folder resolves when the package holds anything beneath it.
 *
 * The one place the parse output meets the submission, so the rule is stated once
 * and both halves - what resolved and what did not - come from the same reading.
 * Exported because they ARE one reading: a caller wanting both should not parse the
 * file twice to get them.
 * @param {Addon} addon
 * @returns {{resolved: VendorEntry[], missing: VendorEntry[]}}
 */
export function readVendorDeclarations(addon) {
  const paths = new Set(addon.files.keys());
  const holds = (dir) => [...paths].some((p) => p.startsWith(`${dir}/`));
  const resolved = [];
  const missing = [];
  const seen = new Set();
  for (const r of scanVendorRecords(addon)) {
    const path = normalizeToken(r.token);
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    const here = r.kind === "folder" ? holds(path) : paths.has(path);
    (here ? resolved : missing).push({
      path,
      sourceUrl: r.sourceUrl,
      kind: r.kind,
    });
  }
  return { resolved, missing };
}

/**
 * Parse the add-on's VENDOR file into the third-party entries it declares: each a
 * packaged-file path and the http(s) source URL paired with it. A declared path the
 * submission does not hold is not here - it is in missingVendorEntries.
 * Deterministic and pure; returns [] when there is no VENDOR file.
 * @param {Addon} addon
 * @returns {VendorEntry[]}
 */
export function parseVendorManifest(addon) {
  return readVendorDeclarations(addon).resolved;
}

/**
 * The declared paths the submission does NOT hold - the other half of the same
 * reading. Deterministic and pure; returns [] when there is no VENDOR file.
 * @param {Addon} addon
 * @returns {VendorEntry[]}
 */
export function missingVendorEntries(addon) {
  return readVendorDeclarations(addon).missing;
}
