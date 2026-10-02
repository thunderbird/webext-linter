// Walks a submitted artifact - an .xpi/.zip archive or an already-unpacked directory - into
// the Addon model: a file store, plus the views a review reads it through. One entry point
// per kind: loadAddon for the built add-on, loadSourceArchive for the submitted source. It
// stays on disk for the whole review, so the store keeps keys and reads bytes when something
// asks (./store.js); nothing is held twice. What the add-on DECLARES is a separate question,
// asked once for the shipped artifact (readWebExtManifest).
//
// A packed archive is read exactly once, by being extracted to disk (extractZip) and then
// walked back like any already-unpacked submission (readDir). That destination is the
// caller's to choose (loadAddon's `extractTo`): the review names it once, in meta.xpiRoot,
// and hands the SAME folder to the reviewer and to this loader.
//
// It also PARTITIONS a submitted SCA archive into the two views a source review reads - the
// add-on code and the Experiment implementation - as views over that one store (scaViews). One
// pass and one set of prefixes, so no two of them can disagree about where a file went, and ONE
// frame: every view is keyed against the submission, which is the only frame that can name
// all of it.
//
// Loading is also where an artifact is NAMED: each entry point says which kind it built
// (`kind`), and the Addon mints loci in itself (`at`). Here because the loader is the only
// place that knows without being told - after this an Addon is a bag of files, and every
// reader that needed the answer would be inferring it from how it got there.
//
// Belongs here: walking either artifact into the Addon model, extracting a packed one to disk
// first, the SCA partition above, naming the artifact and minting loci in it, reading one
// artifact's manifest.json into the record every reader shares, the Manifest and
// WebExtManifestRecord typedefs, and the load-time path guards.
//
// Does NOT belong here: reviewing the add-on - all verdicts live in the checks
// (src/checks/*). Which of the build candidates the build actually RUNS is a
// collection policy, seeded from package.json (-> src/build/collect.js
// collectBuildFiles). Enumerating which JS sources to scan is src/addon/sources.js.
// Parsing CSS/HTML/CSP content is src/scan/*. Schema files load via
// src/schema/load.js. Choosing a non-colliding destination is
// src/util/dest.js, shared with the SCA source archive.

import { ARTIFACT_SCA, ARTIFACT_XPI, isArtifact } from "../lib/artifacts.js";
import { wiringError } from "../lib/errors.js";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import JSON5 from "json5";

import { buildManifestLoc } from "./manifest-loc.js";
import { ARCHIVE_EXTENSIONS, extname } from "../util/files.js";
import { displayLine } from "../util/text.js";
import { hidesItsSize } from "../util/zip.js";
import { ADDON_MAX_UNPACKED_BYTES } from "../config.js";
import { extractionDestination, EXTRACTED_SUFFIX } from "../util/dest.js";
import { FileStore, fileView } from "./store.js";
import { SYMLINK_CAUSE } from "../lib/enum.js";
import { rethrowIfFatal } from "../lib/errors.js";

/**
 * @typedef {object} GeckoSettings
 * @property {string} [id]  Extension id.
 * @property {string} [strict_min_version]  Lowest supported app version.
 * @property {string} [strict_max_version]  Highest supported app version.
 */

/**
 * One content_scripts entry.
 * @typedef {object} ContentScript
 * @property {string[]} [matches]  URL match patterns.
 * @property {string[]} [js]  Injected script paths.
 * @property {string[]} [css]  Injected stylesheet paths.
 */

/**
 * A web_accessible_resources entry in MV3 object form (MV2 uses bare strings).
 * @typedef {object} WebAccessibleResource
 * @property {string[]} [resources]  Exposed resource paths or globs.
 * @property {string[]} [matches]  Origins the resources are exposed to.
 */

/**
 * The background context (MV2 scripts/page or MV3 service worker).
 * @typedef {object} Background
 * @property {string[]} [scripts]  Background script paths (MV2).
 * @property {string} [service_worker]  Service worker path (MV3).
 * @property {string} [page]  Background page path.
 */

/**
 * The sidebar_action manifest.json key.
 * @typedef {object} SidebarAction
 * @property {string} [default_panel]  Panel document path.
 * @property {string} [default_icon]  Icon path.
 * @property {string} [default_title]  Sidebar title.
 */

/**
 * The parsed manifest.json, an open-ended JSON object, so these are just the keys
 * the review reads (others may be present).
 * @typedef {object} Manifest
 * @property {number} [manifest_version]  2 or 3.
 * @property {string} [name]  Add-on name.
 * @property {string} [version]  Add-on version.
 * @property {string} [default_locale]  Default _locales subdir.
 * @property {string[]} [permissions]  Declared permissions / host patterns.
 * @property {string[]} [optional_permissions]  Runtime-granted permissions.
 * @property {string[]} [host_permissions]  Host patterns (MV3).
 * @property {ContentScript[]} [content_scripts]  Declared content scripts.
 * @property {(string|WebAccessibleResource)[]} [web_accessible_resources]
 *   Resources exposed to web pages (MV2 strings, MV3 objects).
 * @property {{gecko?: GeckoSettings}} [browser_specific_settings]  Gecko data.
 * @property {{gecko?: GeckoSettings}} [applications]  Legacy gecko data.
 * @property {Record<string, object>} [experiment_apis]  Experiment API defs.
 * @property {{images?: Record<string, string>}} [theme]  Static theme.
 * @property {SidebarAction} [sidebar_action]  Sidebar action.
 * @property {{page?: string}} [options_ui]  Options UI page.
 * @property {string} [options_page]  Legacy options page path.
 * @property {Background} [background]  Background context.
 * @property {Record<string, string>} [icons]  Size -> icon path.
 * @property {Record<string, string>} [dictionaries]  Locale -> dictionary path.
 * @property {string|Record<string, string>} [content_security_policy]  CSP.
 */

/**
 * One artifact's manifest.json, read ONCE at load: the parse and everything derived from the
 * same bytes, as one value. A record or nothing, so an artifact with no manifest.json answer says
 * so once - parallel fields could disagree, and an empty one reads as an answer.
 * @typedef {object} WebExtManifestRecord
 * @property {boolean} present  Whether the artifact ships a manifest.json at all. The ONE
 *   field that tells absent from unparsable, which `json` cannot: it is null for both, and
 *   the two are different findings (manifest-missing, manifest-invalid-json) owed different
 *   words.
 * @property {?Manifest} json  Parsed; null when the text would not parse, and null when
 *   there was no text.
 * @property {string} text  The raw bytes as text, kept so a reader locating a token in the
 *   source does not re-read and re-parse the file.
 * @property {?string} error  The parse error message; null when `json` is the answer.
 * @property {?import("./manifest-loc.js").ManifestLoc} loc  Resolves a JSON path in manifest.json to
 *   its source line.
 * @property {(...path: (string|number)[]) => {file: string, loc: ?object,
 *   artifact: string}} locus  WHERE in this manifest.json, by the JSON path of the value
 *   it is about, and the only way to point into it - an Addon refuses to mint one. Always
 *   the XPI's, the shipped declaration being read off the built package, so a check
 *   reporting against a manifest value says where it is even when the code it read is in
 *   the other artifact, which no route can describe.
 */

/**
 * An Addon is the CONTENT of one loaded artifact and carries no path of its own. Where it
 * came from is the caller's: the options named it, and the review's `meta` records it
 * (src/pipeline.js). Nothing here resolves a path, derives a lookup from one, or reads it
 * back - a check is handed no path at all (src/checks/context.js projectCtx builds the
 * whole ctx, and none of its fields is one) - so a path stapled on at load could only
 * drift from the one the run was given. It also has no honest value for a source review,
 * whose files are a SUBTREE of an archive: no single path names that, and for a zip root
 * none exists.
 * @typedef {object} Addon
 * @property {string} kind  WHICH artifact this is - the built XPI, or the submitted
 *   source code archive (src/lib/artifacts.js). Set where it is loaded, because the
 *   loader is the only place that knows without being told, and required there. It
 *   reaches a finding through `at` below rather than being read off this field.
 * @property {(file?: ?string, loc?: ?object) => object} at  Mint a locus IN this artifact:
 *   `{file, loc, artifact}`. Every finding, escalated case and feed note carries one, so
 *   a check calls this for each - nothing fills the artifact in afterwards. With no file
 *   the locus is the ARTIFACT, which is what a claim about the package rather than about
 *   something in it points at. Refuses manifest.json: that one belongs to the record
 *   (locusMinter says why).
 * @property {FileView} files  The artifact's own files - what its review READS -
 *   keyed by a path relative to the SUBMISSION root (posix "/"). One frame for every part,
 *   because a file beside the add-on has no add-on-relative spelling and a key set written there
 *   could not hold one. Always a VIEW (./store.js fileView), whatever the artifact: for a
 *   built XPI it holds every key the store has, because every file it holds is a file it
 *   ships; for a source archive it holds everything but the Experiment implementation, which
 *   is its own view (scaViews). One shape either way, so a reader never has to know which
 *   kind of artifact produced it.
 *
 *   A manifest.json is a file the submission contains and is held here like any other.
 *   It is not an ANSWER: what the add-on's manifest.json says is ctx.manifest, the shipped
 *   record every ctx carries (src/checks/context.js), read off the built XPI in either
 *   review - a source archive is loaded without reading one (loadSourceArchive), because
 *   its root manifest.json is a pre-build template. So a check asks ctx.manifest and never
 *   the files, in either mode.
 * @property {FileStore} [store]  Everything the artifact holds - what the submission CONTAINS -
 *   keyed relative to the root the reviewer was given: everything it holds, exactly as it
 *   arrived, and the FileStore every view resolves its bytes through (./store.js). For a
 *   built XPI that is the whole package, which `files` reviews entire. For a source archive it
 *   is the whole --sca-root, the frame the package file and the lock are read in and the frame
 *   a reviewer resolves a reported path against, while `files` there gives up the Experiment
 *   subtree. Reach for it deliberately: a reader asking `store` is saying it wants the
 *   submission entire.
 * @property {string[]} nodeModules  Posix paths of node_modules directories
 *   skipped at load (their contents are never read); empty when none, and always empty
 *   unless the load asked for it, which only loadSourceArchive does. committed-node-modules rejects each, and is the only
 *   thing in the review that knows the name: nothing else has to, because for every other
 *   artifact such a folder is content and is loaded as content. Set by loadAddon, so an
 *   add-on assembled as a view of an archive (scaViews) carries none.
 * @property {string[]} archives  Posix paths of committed binary archives
 *   (.zip/.xpi/... anywhere in the submission); empty when none. In SCA mode the
 *   committed-build-artifact check rejects each. Recorded at load, spanning the whole
 *   --sca-root (before the source/build split), so one is caught wherever it sits. Set by
 *   loadAddon only.
 * @property {string[]} skipped  Ready-to-narrate notices for entries skipped at
 *   load (a non-node_modules symlink); empty when none. A DIRECTORY submission is the
 *   only source: a packed archive names nothing here, since it is extracted with no
 *   symlink of its own (extractZip writes bytes, never a link) and a name extractZip
 *   will not take refuses the whole archive instead. This is the FEED side of a skipped
 *   link, saying why bytes are missing from the store; whether the link is also a
 *   finding is a separate question, answered from `symlinks` by the checks. The loader
 *   collects them; the pipeline narrates them under "Reading add-on", so a pre-banner
 *   sizing load prints nothing before the Setup banner. Set by loadAddon only.
 * @property {{path: string, cause: import("../lib/enum.js").SymlinkCause}[]} symlinks  Every symbolic link the load
 *   met, posix path and what its target turned out to be; empty when none. The cause is
 *   a FACT about the link, never a verdict - the two artifacts hold links to different
 *   standards (a source archive may link within itself, an add-on may not link at all),
 *   so the policy lives in the checks that read this and nowhere else. `internal` is a
 *   target inside the submission root, `outside` one beyond it, `broken` one that
 *   resolves to nothing, and `entry` a packed archive that stored the file AS a link,
 *   which is the one cause with no link on disk: extractZip records it and writes
 *   nothing, so the store never holds a file whose bytes are a path. Where an installed
 *   tree is recorded rather than read, a link named node_modules is that tree and is not
 *   here (see nodeModules); everywhere else every link is. Set by loadAddon only.
 * @property {string[]} directories  Posix paths of every directory the walk entered;
 *   empty when none. The file keys cannot answer this: they name files, so a directory is
 *   visible there only as a prefix of one and an EMPTY directory not at all - which is why
 *   a reader asking "is this path a directory in the submission" asks here. A recorded
 *   installed tree is NOT among them: it is not walked, so nothing may resolve into it.
 *   Set by loadAddon only.
 */

/**
 * @param {string} source  Path to an .xpi/.zip file or an unpacked add-on
 *   directory.
 * @param {string} [extractTo]  Where to extract `source` if it is a packed file;
 *   ignored if it is already a directory. Defaults to a fresh `<source>.extracted`
 *   (src/util/dest.js) when omitted - callers that care where it landed (the
 *   review, so it can hand the same folder to a reviewer) pass their own.
 * @param {{kind: string, recordInstalledTrees?: boolean}} options
 *   `kind` says WHICH artifact is being loaded (src/lib/artifacts.js). REQUIRED, and not
 *   defaulted: the loader is the one place that knows without being told, and an Addon that
 *   cannot say what it is silently un-labels every finding reported against it. The two
 *   production callers are the two answers - the pipeline's XPI, and loadSourceArchive's
 *   source archive below.
 *
 *   `recordInstalledTrees` is off by default and describes a submitted SOURCE ARCHIVE,
 *   which asks for it by name; it applies to a folder read, since a source archive arrives
 *   extracted. It makes a node_modules directory a RECORDED path instead of
 *   content: its paths land in `nodeModules` and not one of its files is read. An installed
 *   tree is not part of a submission - the reviewer installs it - so reading it would review
 *   bytes the build replaces. In an ADD-ON, which is what users receive, a folder called
 *   node_modules is shipped content like any other folder and is loaded and reviewed as one.
 * @returns {Addon}
 */
export function loadAddon(
  source,
  extractTo,
  { recordInstalledTrees, kind } = {}
) {
  if (!isArtifact(kind)) {
    throw new Error(
      `loadAddon: kind must be "${ARTIFACT_XPI}" or "${ARTIFACT_SCA}", got ` +
        `${JSON.stringify(kind)} - an artifact says which one it is, and nothing ` +
        "downstream can work it out afterwards."
    );
  }
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Add-on not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  let store, nodeModules, archives, skipped, symlinks, directories;
  if (stat.isDirectory()) {
    ({ store, nodeModules, archives, skipped, symlinks, directories } = readDir(
      resolved,
      kind,
      recordInstalledTrees
    ));
  } else {
    const dest =
      extractTo ?? extractionDestination(`${resolved}${EXTRACTED_SUFFIX}`);
    // A stored link entry is what extractZip will not put on disk, so it is what the
    // read-back below cannot rediscover there - everything else (files, archives, symlink
    // notices) is real on disk after extraction and is read the same way an
    // already-unpacked submission's is.
    const packed = extractZip(resolved, dest);
    const unpackedDir = readDir(dest, kind);
    ({ store, nodeModules, archives, skipped, directories } = unpackedDir);
    // Both halves, so which one can see a link is not a fact this line depends on.
    symlinks = [...packed.symlinks, ...unpackedDir.symlinks];
  }
  // An artifact loaded on its own has nothing to hold back - every file it holds is a file
  // it ships - so its `files` is a view over every key the store has. It says that by
  // HOLDING all of them rather than by being the store: one shape for every artifact, so a
  // reader of `files` never has to know which kind produced it. A SOURCE archive narrows
  // the same field later (scaViews).
  return {
    // WHICH artifact this is, said by the thing that IS it - rather than worked back out
    // from the route it was reached by and the mode the review is in.
    kind,
    // Mint a locus IN this artifact. Every finding, escalated case and feed note carries
    // one, so a check calls this for each: the holder answers, and neither the report nor
    // the agent has to work out which artifact a path is in.
    at: locusMinter(kind),
    files: fileView(store, { keys: store.keys() }),
    store,
    nodeModules,
    archives,
    skipped,
    symlinks,
    directories,
  };
}

/**
 * Load the SUBMITTED SOURCE ARCHIVE - the artifact --sca-root names.
 *
 * The one way it is not an add-on, stated here so no caller restates it: an installed
 * dependency tree is not part of a submission (the reviewer installs it from the declared
 * package file and lock), so it is recorded rather than read as content. A caller asking for
 * a submission asks for it by name.
 *
 * No `extractTo`: --sca-root is a directory by the time anything loads it, extracted by the
 * reviewer and settled before the review starts (src/addon/submission.js, sca-root.js).
 * @param {string} source  Absolute path to the extracted source root.
 * @returns {Addon}
 */
export function loadSourceArchive(source) {
  return loadAddon(source, undefined, {
    recordInstalledTrees: true,
    kind: ARTIFACT_SCA,
  });
}

// The add-on's own manifest, by name - recognized at any depth.
/** The one filename a WebExtension manifest has. Module-private: the record mints its own
 *  loci (`at` below), so nothing outside has to spell the name to point into it. */
const MANIFEST_NAME = "manifest.json";

/**
 * Read the artifact's ROOT manifest.json (BOM-tolerant, JSON5) into the record every reader of
 * that manifest.json shares. Asked for, never derived at load: the record is the SHIPPED
 * answer to "what does this add-on declare", so the review reads it once off the built XPI
 * and shares it (src/pipeline.js -> ctx.manifest). A source archive is never asked - its root
 * manifest.json is a PRE-BUILD template, which the build may rewrite or generate, whose
 * add-on root may sit anywhere under the submission, and which a submission need not hold at
 * all. The store is left alone either way: reading a file is not a reason to take it away.
 *
 * ALWAYS a record, absent manifest.json or not: a reader asking what the add-on declares
 * gets the same shape either way, and says which case it is by reading `present`. Unparsable
 * is a record too - `error` is what the review reports and `text` is what a token search
 * anchors it in, while `loc` answers null to everything (buildManifestLoc gets no tree out
 * of text JSON5 alone will take).
 * @param {FileStore} store  The artifact's store, to read it from.
 * @returns {WebExtManifestRecord}
 */
export function readWebExtManifest(store) {
  const manifestBuf = store.get(MANIFEST_NAME);
  return manifestRecord(manifestBuf ? manifestBuf.toString("utf8") : null);
}

/**
 * The manifest.json record of a PACKED add-on, read without extracting it: for a caller that
 * prepares a review and writes nothing (--llm-sca-review). An archive that cannot be read
 * answers as one with no manifest.json - the review being prepared reads it in full and
 * refuses it there, in its own words.
 * @param {string} zipPath
 * @returns {WebExtManifestRecord}
 */
export function readPackedManifest(zipPath) {
  try {
    const entry = new AdmZip(zipPath).getEntry(MANIFEST_NAME);
    if (
      entry &&
      !entry.isDirectory &&
      !hidesItsSize(entry) &&
      entry.header.size <= ADDON_MAX_UNPACKED_BYTES
    ) {
      return manifestRecord(entry.getData().toString("utf8"));
    }
  } catch (err) {
    rethrowIfFatal(err);
  }
  return manifestRecord(null);
}

/**
 * The record itself, from the raw bytes. Separate from the read so the shape has ONE
 * owner: a second hand-built copy of it is a copy that goes out of step the next time it
 * gains a field, which is how a locus once reached a reader with no artifact on it.
 * @param {?string} raw  The manifest.json bytes as text, BOM and all, or null when the
 *   artifact ships none - which is a record like any other, saying so with `present`.
 * @returns {WebExtManifestRecord}
 */
export function manifestRecord(raw) {
  const present = raw !== null;
  const bytes = present ? raw : "";
  const text = bytes.charCodeAt(0) === 0xfeff ? bytes.slice(1) : bytes;
  const record = {
    present,
    json: null,
    // The bytes AS SUBMITTED, BOM and all - what a finding quotes is the file the developer
    // sent, and the empty string where there is no file to quote. The parse and the line
    // index take the stripped copy, which neither can read past.
    text: bytes,
    error: null,
    loc: buildManifestLoc(text),
    // WHERE in the shipped manifest.json, by the JSON path of the value it is about - and
    // the ONLY way to point into it. Not `at`, which is an artifact's question ("which
    // file, in me"); this one answers "where inside the one file I am", so it names the
    // file itself and no caller spells it.
    //
    // ALWAYS the XPI's: the record is the shipped declaration, read once off the built
    // package (the read above says why a source archive is never asked), so there is no
    // second answer to take as an argument. That is what lets a check reporting against a
    // manifest value say where it is even when the code it read is in the other artifact -
    // the case no route can describe (missing-permission: an API call in the source, the
    // declaration it needs in the shipped manifest.json).
    locus(...jsonPath) {
      const line = record.loc?.lineAt(jsonPath) ?? null;
      return {
        file: MANIFEST_NAME,
        loc: line ? { line } : null,
        artifact: ARTIFACT_XPI,
      };
    },
  };
  if (present) {
    try {
      record.json = JSON5.parse(text);
    } catch (err) {
      record.error = err.message;
    }
  }
  return record;
}

/**
 * The `at` an artifact of this kind mints with - built here, and by the test helper that
 * stands in for a loaded artifact, so a fixture cannot be more permissive than the real
 * thing.
 *
 * It refuses the shipped manifest.json. That file is the one whose authoritative copy is
 * fixed regardless of route - always the built XPI's - while a source archive holds a file
 * of the same name that is a DIFFERENT file, a pre-build template. A path spelled here
 * would therefore mean one or the other depending on which route the check happened to be
 * on, which is what every version of this bug has been. The record has one answer, so the
 * record is asked.
 * @param {string} kind  Which artifact is minting (src/lib/artifacts.js).
 * @returns {(file?: ?string, loc?: ?object) => object}
 */
export function locusMinter(kind) {
  return (file = null, loc = null) => {
    if (file === MANIFEST_NAME) {
      throw wiringError(
        `an artifact was asked to mint a locus in "${MANIFEST_NAME}" - the shipped ` +
          "declaration is the record's to point into, whatever artifact you are on: " +
          "ctx.manifest.locus(...jsonPath)"
      );
    }
    return { file, loc, artifact: kind };
  };
}

/**
 * The archive key for a path INSIDE scaRoot: where it sits relative to the root, keyed the
 * way an archive keys its entries.
 *
 * Both are absolute by the time they reach here - the arg-array reader resolved them
 * (src/cli.js), which is the one layer that knows what each flag was written relative to -
 * so this asks one question of two real paths rather than deciding again what a relative
 * string meant. A path that is not inside the root is refused: the files map has no key for
 * it, and a review cannot be shown to cover what sits outside the tree it was given.
 *
 * Judged as the PLATFORM spells paths (node's `path` is posix here and win32 there), never
 * by rewriting a separator first: a backslash is a separator on Windows and an ordinary
 * character in a POSIX file name, and only the platform knows which this is. The answer is
 * keyed posix, like every other add-on-internal path.
 * @param {string} value  The absolute path to locate.
 * @param {string} scaRoot  The absolute --sca-root path.
 * @param {string} [flag]  The flag name to name in the error (e.g. "--sca-exp-source").
 * @returns {string} A posix path relative to scaRoot ("" for the root itself).
 */
export function scaRootRelative(value, scaRoot, flag = "SCA path") {
  const rel = relativeInside(value, scaRoot);
  if (rel === null) {
    throw new Error(
      `${flag} "${value}" is not inside --sca-root (${scaRoot}) - it names a folder ` +
        "within the source root, never a way out of one"
    );
  }
  return rel;
}

/**
 * The same question without the throw: where `value` sits inside `scaRoot`, or null when it
 * sits outside it.
 *
 * Two layers ask it - the CLI guard, which turns the answer into a usage line naming the
 * flag, and the loader, which turns it into an archive key - and they must not be able to
 * disagree, so both ask HERE. Either path may be written absolute or relative; both are
 * resolved first, so "inside" is a fact about the filesystem rather than about spelling.
 * @param {string} value
 * @param {string} scaRoot
 * @returns {?string} A posix path relative to scaRoot ("" for the root itself), or null.
 */
export function relativeInside(value, scaRoot) {
  const rel = path.relative(
    path.resolve(scaRoot),
    path.resolve(String(value ?? ""))
  );
  if (path.isAbsolute(rel) || hasParentSegment(rel)) {
    return null;
  }
  return rel === "" ? "" : rel.split(path.sep).join("/");
}

/**
 * Whether a path, as WRITTEN, steps out of the tree it is relative to: any segment that is
 * "..", not only a leading one.
 *
 * Named once because two layers ask it of two different things - src/cli.js of the folder
 * flags it is handed (including --sca-root, which never reaches the path math here), and
 * scaRootRelative of every value it resolves, for the callers that never pass a CLI at all.
 * Asked of the written form rather than of the resolved one, so "src/../other" is refused
 * as surely as "../other": a value that names a folder by the way out of another is a
 * value someone will misread, whether or not it lands back inside.
 * @param {string} value
 * @returns {boolean}
 */
export function hasParentSegment(value) {
  return String(value ?? "")
    .split(/[/\\]/)
    .includes("..");
}

/**
 * PARTITION a source code archive into the two parts a source review reads, as views
 * over the one store the archive was walked into (./store.js). Every file is held once,
 * by the store; a view adds the key set it holds. Neither view re-keys: both spell a file
 * the way the submission does.
 *
 *   source      everything the archive holds, MINUS the Experiment subtree. The whole of
 *               it, because a build script may put any file anywhere: nothing in the
 *               archive can be assumed unused, so the archive IS what the review reads and
 *               there is no narrower add-on subtree to carve out of it. With the
 *               experiment view it is what the build trace runs over (src/build/collect.js
 *               collectBuildFiles, via analyzeBuild), which narrows it to the files reached from the root
 *               package.json. An installed dependency tree is in neither: loadAddon records
 *               the directory paths for committed-node-modules and reads none of it.
 *   experiment  the Experiment implementation at `scaExpSource`, wherever it sits - inside
 *               the source or beside it. Privileged, non-WebExtension code: it is recorded
 *               here ONCE so nothing downstream has to re-derive where it went.
 *
 * The two are disjoint, and together they serve both the code review and the build
 * trace (./store.js withExperiment): the tooling is intermingled with the code, so there is no line to draw between
 * them. One pass, one set of prefixes, so no two readers can disagree about where a file
 * went.
 *
 * A manifest.json here is a file like any other. The archive is loaded without reading one
 * into a record (loadSourceArchive), because a pre-build template is not what Thunderbird
 * loads - so the question "what does the add-on's manifest.json say" has exactly one answer,
 * the built XPI's, which every ctx carries as ctx.manifest (src/checks/context.js).
 * Withholding the FILE would say instead that the submission does not contain it.
 *
 * The source and the experiment are keyed alike whenever the Experiment sits inside the
 * add-on, so a check that must review the privileged code too reads the two as one set of files
 * (`source.experiment` carries it onto the review addon for exactly that).
 * @param {Addon} archive  The scaRoot archive, loaded ONCE (loadSourceArchive).
 * @param {{scaRoot: string, scaExpSource?: string}} where  Absolute paths, resolved by the
 *   arg-array reader (src/cli.js). scaExpSource may sit anywhere under the root.
 * @returns {Addon}  The SAME archive, now carrying its two views. Not a new object:
 *   the store and the recorded path lists already describe this submission, and copying
 *   them onto parts is how they came to disagree.
 */
export function scaViews(archive, { scaRoot, scaExpSource }) {
  const store = archive.store;
  const exp = scaExpSource
    ? scaRootRelative(scaExpSource, scaRoot, "--sca-exp-source")
    : null;
  // A prefix that was never given (no --sca-exp-source) is under nothing.
  const under = (key, prefix) =>
    Boolean(prefix) && (key === prefix || key.startsWith(`${prefix}/`));

  const sourceKeys = [];
  const expKeys = [];
  for (const key of store.keys()) {
    (under(key, exp) ? expKeys : sourceKeys).push(key);
  }

  archive.experiment = fileView(store, { keys: expKeys });
  archive.files = fileView(store, { keys: sourceKeys });
  return archive;
}

/**
 * The refusal for a submission holding a file this machine cannot read - an invalid input,
 * named by artifact, with the file and the reason, so whoever submitted it can fix it.
 * @param {string} kind  ARTIFACT_XPI or ARTIFACT_SCA.
 * @param {string} rel  The file's path inside the submission.
 * @param {NodeJS.ErrnoException} err  Why it cannot be read.
 * @returns {Error}
 */
function unreadableFileError(kind, rel, err) {
  const artifact = kind === ARTIFACT_SCA ? "source archive" : "XPI";
  const reason =
    err?.code === "EACCES" || err?.code === "EPERM"
      ? "permission denied"
      : (err?.code ?? "unreadable");
  return new Error(`Invalid ${artifact}: ${rel} cannot be read (${reason}).`);
}

/** @returns {Error} The add-on-too-large error, shared by extractZip and readDir. */
function addonTooLargeError() {
  const mb = ADDON_MAX_UNPACKED_BYTES / (1024 * 1024);
  return new Error(`Add-on unpacked size exceeds the ${mb} MB limit`);
}

/**
 * One sentence for an archive we cannot read, shared by extractZip's refusals: the
 * container will not open, two entries name one path, an entry name is not one we take, an
 * entry hides its size or will not inflate.
 * They are one answer because they have one consequence - no review of this submission can
 * be complete - and because the alternative is AdmZip's own wording, which either names its
 * internals or quotes a file name out of the archive.
 *
 * It names the archive and NOTHING from inside it. The path is the caller's own (they typed
 * it); an entry name is the submission's text, and a refusal is not a place to start
 * escaping user data.
 * @param {string} zipPath
 * @returns {Error}
 */
function unreadableArchiveError(zipPath) {
  return new Error(`Could not read archive: ${zipPath}`);
}

/**
 * Extract a packed archive to `destDir`, entry by entry, applying the same refusals
 * a review of it applies; the validated bytes land on disk rather than in a Map.
 *
 * Never AdmZip's own extractAllTo/extractEntryTo: those replay the archive's OWN
 * claims about each entry (its stored path, its stored Unix mode), which is exactly
 * what isSafeAddonPath exists to refuse rather than trust - and a mode claiming
 * "symlink" would have AdmZip create a real one on disk from bytes we did not
 * write. Every entry here is read with getData() and written with writeFileSync, so
 * what lands on disk is never anything other than the file it claims to be.
 *
 * The mode is still READ, for the one claim worth recording: an entry stored as a link
 * holds a path where a file's bytes belong, so writing it would put a file in the store
 * whose whole content is the name of another one. It is recorded and dropped instead.
 *
 * destDir is always this call's own fresh destination (the caller computed it, or
 * defaulted it, right before calling this), so a refusal removes it rather than
 * leaving a partial extraction beside the submission for a reviewer to mistake for
 * the whole thing.
 * @param {string} zipPath  Path to the .xpi/.zip archive.
 * @param {string} destDir  Where to write it. Created if missing.
 * @returns {{symlinks: {path: string, cause: object}[]}}  The stored links skipped and
 *   never written - the fact a later read of destDir cannot recover, because nothing is
 *   there to find.
 */
function extractZip(zipPath, destDir) {
  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch (err) {
    rethrowIfFatal(err);
    // The container itself: truncated, or not a zip at all.
    throw unreadableArchiveError(zipPath);
  }
  // An archive whose entries do not name each file exactly once has no single meaning:
  // readers disagree on which copy wins (this one writes both and keeps the last, `unzip`
  // and Gecko read the first), so whichever we reviewed, another reader sees the other.
  // Refused before anything is written, like a name we will not take.
  const entries = zip.getEntries();
  if (
    namesCollide(
      entries.filter((e) => !e.isDirectory).map((e) => entryKey(e.entryName))
    )
  ) {
    throw unreadableArchiveError(zipPath);
  }
  const symlinks = [];
  let unpacked = 0;
  // Created up front, not only by the first entry's own mkdirSync: an archive with no
  // file entries at all (only directories) would otherwise leave nothing here for
  // readDir to walk.
  fs.mkdirSync(destDir, { recursive: true });
  try {
    for (const entry of entries) {
      if (entry.isDirectory) {
        continue;
      }
      const name = entryKey(entry.entryName);
      // An entry name we will not take is an archive we cannot review: every file in the
      // package has to be accounted for, so passing over the ENTRY would leave a review
      // silently covering less than the submission. Refused rather than repaired -
      // rewriting a name can invent a directory the archive does not have, and two
      // spellings of one path would collide on disk, letting entry order decide which
      // bytes survive.
      if (!isSafeAddonPath(name)) {
        throw unreadableArchiveError(zipPath);
      }
      // An entry the archive stored AS a link carries a target path where a file's bytes
      // belong. Record it and skip BEFORE getData(), so the store never holds a file
      // whose entire content is the name of another one.
      if (isStoredLink(entry)) {
        symlinks.push({ path: name, cause: SYMLINK_CAUSE.ENTRY });
        continue;
      }
      // Bound decompression against a zip bomb by the declared size, before getData():
      // adm-zip inflates into a buffer of exactly that size, but caps inflation by it only
      // when it is non-zero, so an entry declaring none while carrying data is refused
      // first.
      if (hidesItsSize(entry)) {
        throw unreadableArchiveError(zipPath);
      }
      if (unpacked + entry.header.size > ADDON_MAX_UNPACKED_BYTES) {
        throw addonTooLargeError();
      }
      let data;
      try {
        data = entry.getData();
      } catch (err) {
        rethrowIfFatal(err);
        // The container opened and the name was fine, but this entry does not inflate: a
        // failed CRC, a damaged stream. The bytes are part of the submission, so a review
        // without them is not a review of it.
        throw unreadableArchiveError(zipPath);
      }
      // The same cap on the bytes actually returned: adm-zip never returns more than the
      // header declared, so this holds only if a future version did.
      unpacked += data.length;
      if (unpacked > ADDON_MAX_UNPACKED_BYTES) {
        throw addonTooLargeError();
      }
      const dest = path.join(destDir, ...name.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
  } catch (err) {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw err;
  }
  return { symlinks };
}

// A zip entry's external attributes carry the Unix mode in their high 16 bits, and the
// file-type field of that mode says what the entry claims to be. 0 is what an archiver
// that records no Unix mode at all writes, and reads as "not a link" like any other
// non-link type.
const UNIX_MODE_SHIFT = 16;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * Whether the archive stored this entry as a symbolic link rather than a file.
 * @param {{attr?: number}} entry  An AdmZip entry.
 * @returns {boolean}
 */
function isStoredLink(entry) {
  const mode = (entry.attr ?? 0) >>> UNIX_MODE_SHIFT;
  return (mode & S_IFMT) === S_IFLNK;
}

/**
 * @param {string} dir  Root directory of the unpacked add-on.
 * @param {string} kind  Which artifact this is (src/lib/artifacts.js), for the refusal when a
 *   file in it cannot be read.
 * @param {boolean} [recordInstalledTrees]  See loadAddon: record a node_modules directory
 *   as a path instead of walking it. Off means it is an ordinary folder, walked and keyed
 *   like any other, which is what a shipped add-on's folders are.
 * @returns {{store: FileStore, nodeModules: string[], archives: string[],
 *   skipped: string[], symlinks: {path: string, cause: object}[],
 *   directories: string[]}}  The walk's one store, plus the paths it recorded without
 *   reading. A view over it is the caller's to build (loadAddon, scaViews).
 */
function readDir(dir, kind, recordInstalledTrees) {
  const keys = [];
  const nodeModules = [];
  const archives = [];
  const skipped = [];
  const symlinks = [];
  const directories = [];
  let unpacked = 0;
  // Resolved once, and resolved at all: the classification below compares a link's
  // realpath against this, and relativeInside resolves spellings rather than links. A
  // root reached THROUGH a link (macOS /tmp, which the tests use) would otherwise put
  // every one of its own files outside itself. Unguarded on purpose - a root that cannot
  // be resolved is about to fail the readdirSync below anyway, and falling back to the
  // unresolved path would answer every containment question wrongly in the rejecting
  // direction.
  const rootReal = fs.realpathSync(dir);
  /** @param {string} current  Directory to recurse into. */
  const walk = (current) => {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, e.name);
      if (e.isSymbolicLink()) {
        // Where an installed tree is recorded rather than read, a symlink NAMED
        // node_modules is that tree too: record it by name and let the one check that
        // owns installed trees answer it, so nothing else in the review has to know the
        // name at all. Every other symlink is skipped rather than followed - following
        // could pull in host files or loop - with the skip collected as a notice (the
        // caller narrates it) so it is not silent, and WHERE the target lands recorded
        // as a fact, which the two artifacts' checks hold to their own standards.
        if (recordInstalledTrees && e.name === "node_modules") {
          nodeModules.push(walkedKey(path.relative(dir, full)));
        } else {
          const rel = walkedKey(path.relative(dir, full));
          symlinks.push({ path: rel, cause: linkCause(full, rootReal) });
          skipped.push(`Skipping symlink (not packaged): ${displayLine(rel)}`);
        }
      } else if (e.isDirectory()) {
        // Where an installed tree is recorded rather than read, record it and do NOT
        // recurse, so its (huge) contents never enter memory. Otherwise the name means
        // nothing here and the folder is walked like any other - a shipped add-on's
        // files are its content whatever their directory is called, and the unpacked-size
        // cap below is what keeps a large one bounded.
        if (recordInstalledTrees && e.name === "node_modules") {
          nodeModules.push(walkedKey(path.relative(dir, full)));
        } else {
          // Recorded as well as walked, because the key set cannot say this: it holds
          // files, so a directory exists there only as a prefix of one, and an EMPTY
          // directory not at all. A recorded installed tree is deliberately absent - it
          // is not walked, so nothing may resolve into it.
          directories.push(walkedKey(path.relative(dir, full)));
          walk(full);
        }
      } else if (e.isFile()) {
        const rel = walkedKey(path.relative(dir, full));
        if (ARCHIVE_EXTENSIONS.has(extname(rel))) {
          archives.push(rel);
        }
        // Bound the total unpacked size, matching the archive path's zip-bomb cap. The
        // size is the file's own, read from the directory entry: the bytes stay on disk
        // and the store reads them if something asks (./store.js).
        unpacked += fs.statSync(full).size;
        if (unpacked > ADDON_MAX_UNPACKED_BYTES) {
          throw addonTooLargeError();
        }
        // Readable now, or the submission is invalid: the bytes are read later, on demand,
        // and every one of them has to be reviewed. Decided here, while the tree is loaded,
        // so no review starts on files it cannot read (a source archive's own extraction
        // can restore a permission that denies the reviewer).
        try {
          fs.accessSync(full, fs.constants.R_OK);
        } catch (err) {
          throw unreadableFileError(kind, rel, err);
        }
        keys.push(rel);
      }
    }
  };
  walk(dir);
  return {
    store: new FileStore(dir, keys),
    nodeModules,
    archives,
    skipped,
    symlinks,
    directories,
  };
}

/**
 * Where a symbolic link's target lands, relative to the root being walked: "internal",
 * "outside", or "broken" when it resolves to nothing.
 *
 * realpathSync is what makes this a question about the filesystem rather than about
 * spelling - it follows the whole chain, so a link through a link through an escape is
 * the escape it ends at, and it throws (ENOENT, or ELOOP for a cycle) exactly when there
 * is nothing at the end. relativeInside then answers containment, the same way every
 * other caller asks it.
 * @param {string} full  Absolute path OF the link itself.
 * @param {string} rootReal  The walk root, already resolved.
 * @returns {string}
 */
function linkCause(full, rootReal) {
  let target;
  try {
    target = fs.realpathSync(full);
  } catch (err) {
    rethrowIfFatal(err);
    return SYMLINK_CAUSE.BROKEN;
  }
  return relativeInside(target, rootReal) === null
    ? SYMLINK_CAUSE.OUTSIDE
    : SYMLINK_CAUSE.INTERNAL;
}

/**
 * An add-on-internal path as the file map keys it: posix, without a leading "./".
 *
 * A ZIP entry name is already posix - the format says so ("All slashes MUST be forward
 * slashes '/' as opposed to backwards slashes") - so nothing is rewritten here. A
 * backslash in an entry name is therefore part of the NAME, which is the only reading that
 * cannot invent a directory that the archive does not have.
 *
 * The leading "./" is the one exception, because `zip -r ./dir` writes it on every entry
 * and it names the package root unambiguously. Every other non-canonical spelling is
 * refused by the caller rather than repaired here (isSafeAddonPath), so this returns a key
 * or the archive is not read at all.
 * @param {string} p  An entry name as the archive spells it.
 * @returns {string}
 */
function entryKey(p) {
  return p.replace(/^\.\//, "");
}

/**
 * Whether two of an archive's file keys name one path: the same key twice (two entries,
 * or two spellings entryKey maps together), a key that is also another's folder (`lib`
 * beside `lib/a.js`), or keys that differ only in case - which a reviewer extracting on a
 * case-insensitive filesystem gets as ONE file, not the two we reviewed. Compared
 * case-folded for all three, so each rule is asked once.
 * @param {string[]} keys
 * @returns {boolean}
 */
function namesCollide(keys) {
  const files = new Set();
  for (const key of keys) {
    const folded = key.toLowerCase();
    if (files.has(folded)) {
      return true;
    }
    files.add(folded);
  }
  for (const key of files) {
    const segs = key.split("/");
    for (let i = 1; i < segs.length; i++) {
      if (files.has(segs.slice(0, i).join("/"))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * A walked file as the file map keys it: the OS told us this name, so the only conversion
 * is its own separator to posix. `path.sep` and nothing else - rewriting every backslash
 * would rename a file that legitimately carries one.
 * @param {string} rel  A path relative to the add-on root, from path.relative.
 * @returns {string}
 */
function walkedKey(rel) {
  return rel.split(path.sep).join("/");
}

/**
 * True when a normalized add-on-relative path stays inside the add-on root: not
 * empty, not absolute, no Windows drive, and no ".." segment.
 * @param {string} p  Normalized posix path.
 * @returns {boolean}
 */
function isSafeAddonPath(p) {
  if (!p || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {
    return false;
  }
  // Every segment must NAME something. "..", "." and "" are path SYNTAX, not names: they
  // make one file addressable by two spellings, so the key an entry lands under stops being
  // the key the manifest.json's own reference resolves to (normalizeRefInDir drops both while
  // this loader keeps them), and ".." can additionally point outside the package.
  //
  // entryKey has already stripped a LEADING "./" by this point. That is what `zip -r ./dir`
  // produces, it names the package root unambiguously, and it is the one form repaired
  // rather than refused - the asymmetry is deliberate.
  return !p.split("/").some((s) => s === ".." || s === "." || s === "");
}
