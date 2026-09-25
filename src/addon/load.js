// Walks a submitted add-on - an .xpi/.zip archive or an already-unpacked directory - into
// the Addon model: a file store plus the parsed manifest. The submission is on disk for
// the whole review, so the store keeps keys and reads bytes when something asks
// (./corpus.js); nothing is held twice.
//
// A packed archive is read exactly once, by being extracted to disk (extractZip) and then
// walked back like any already-unpacked submission (readDir). That destination is the
// caller's to choose (loadAddon's `extractTo`): the review names it once, in meta.xpiRoot,
// and hands the SAME folder to the reviewer and to this loader.
//
// It also PARTITIONS a submitted SCA archive into the corpora a source review reads - the
// add-on code, the Experiment implementation, and the whole of it the build may reach - as
// views over that one store (scaViews). One pass and one set of prefixes, so no two of them
// can disagree about where a file went, and ONE frame: every corpus is keyed against the
// submission, which is the only frame that can name all of it.
//
// Belongs here: walking the submission into the Addon model (store + manifest parse +
// manifestError), extracting a packed one to disk first, the SCA partition above, the
// Manifest typedef, and the load-time path safety guards.
//
// Does NOT belong here: reviewing the add-on - all verdicts live in the checks
// (src/checks/*). Which of the build candidates the build actually RUNS is a
// collection policy, seeded from package.json (-> src/build/corpus.js
// selectBuildCorpus). Enumerating which JS sources to scan is src/addon/sources.js.
// Parsing CSS/HTML/CSP content is src/scan/*. Schema files load via
// src/schema/load.js. Choosing a non-colliding destination is
// src/util/dest.js, shared with the SCA source archive.

import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import JSON5 from "json5";

import { buildManifestLoc } from "./manifest-loc.js";
import { ARCHIVE_EXTENSIONS, extname } from "../util/files.js";
import { displayLine } from "../util/text.js";
import { ADDON_MAX_UNPACKED_BYTES } from "../config.js";
import { extractionDestination } from "../util/dest.js";
import { FileStore, fileView } from "./corpus.js";
import { SYMLINK_CAUSE } from "../lib/enum.js";

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
 * The sidebar_action manifest key.
 * @typedef {object} SidebarAction
 * @property {string} [default_panel]  Panel document path.
 * @property {string} [default_icon]  Icon path.
 * @property {string} [default_title]  Sidebar title.
 */

/**
 * The parsed manifest.json. A WebExtension manifest is an open-ended JSON
 * object, so these are just the keys the review reads (others may be present).
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
 * An Addon is the CONTENT of one loaded artifact and carries no path of its own. Where it
 * came from is the caller's: the options named it, and the review's `meta` records it
 * (src/pipeline.js). Nothing here resolves a path, derives a lookup from one, or reads it
 * back - the checks cannot even see one (the ctx allowlist, src/checks/context.js) - so a
 * path stapled on at load could only drift from the one the run was given. It also has no
 * honest value for a source review, whose files are a SUBTREE of an archive: no single path
 * names that, and for a zip root none exists.
 * @typedef {object} Addon
 * @property {object} files  The artifact's own corpus, keyed by a path relative to the
 *   SUBMISSION root (posix "/"). One frame for every part, because a file beside the add-on
 *   has no add-on-relative spelling and a corpus keyed there could not hold one. For a
 *   built XPI it IS the store: every file it holds is a file it ships, so there is nothing
 *   to withhold. For a source archive it is a VIEW that gives up every manifest.json
 *   (scaViews/liftManifests), because reading one back there would answer with the
 *   PRE-BUILD manifest where ctx.manifest is the shipped one.
 *
 *   So `files.has("manifest.json")` is TRUE in an XPI review and FALSE in SCA, and a check
 *   must not read the manifest out of the corpus in either: ctx.manifest is the one answer
 *   (src/checks/context.js). In an XPI review nothing stops it any more - the corpus used to,
 *   and the only thing that relied on it was unused-files, which now skips the name itself.
 * @property {object} [store]  The artifact's COMPLETE corpus, keyed relative to the root the
 *   reviewer was given: everything it holds, exactly as it arrived. Nothing is ever dropped
 *   from it, so it answers what the submission CONTAINS rather than what some corpus of it
 *   reviews. For a built XPI that is the whole package, and `files` is the same object -
 *   there is nothing to withhold. For a source archive it is the whole --sca-root, the frame
 *   the build manifest and the lock are read in and the frame a reviewer resolves a reported
 *   path against, while `files` there is a view that gives up the manifests. Reach for it
 *   deliberately: a reader asking `store` is saying it wants the submission entire.
 * @property {string[]} [nodeModules]  Posix paths of node_modules directories
 *   skipped at load (their contents are never read); empty when none, and always empty
 *   unless the load asked for it (loadAddon recordInstalledTrees), which only the
 *   submitted SOURCE ARCHIVE does. committed-node-modules rejects each, and is the only
 *   thing in the review that knows the name: nothing else has to, because for every other
 *   artifact such a folder is content and is loaded as content. Set by loadAddon, so an
 *   add-on assembled as a view of an archive (scaViews) carries none.
 * @property {string[]} [archives]  Posix paths of committed binary archives
 *   (.zip/.xpi/... anywhere in the submission); empty when none. In SCA mode the
 *   committed-build-artifact check rejects each. Recorded at load, spanning the whole
 *   --sca-root (before the source/build split), so one is caught wherever it sits. Set by
 *   loadAddon only.
 * @property {string[]} [skipped]  Ready-to-narrate notices for entries skipped at
 *   load (a non-node_modules symlink); empty when none. A DIRECTORY submission is the
 *   only source: a packed archive names nothing here, since it is extracted with no
 *   symlink of its own (extractZip writes bytes, never a link) and a name extractZip
 *   will not take refuses the whole archive instead. This is the FEED side of a skipped
 *   link, saying why bytes are missing from the corpus; whether the link is also a
 *   finding is a separate question, answered from `symlinks` by the checks. The loader
 *   collects them; the pipeline narrates them under "Reading add-on", so a pre-banner
 *   sizing load prints nothing before the Setup banner. Set by loadAddon only.
 * @property {{path: string, cause: import("../lib/enum.js").SymlinkCause}[]} [symlinks]  Every symbolic link the load
 *   met, posix path and what its target turned out to be; empty when none. The cause is
 *   a FACT about the link, never a verdict - the two artifacts hold links to different
 *   standards (a source archive may link within itself, an add-on may not link at all),
 *   so the policy lives in the checks that read this and nowhere else. `internal` is a
 *   target inside the submission root, `outside` one beyond it, `broken` one that
 *   resolves to nothing, and `entry` a packed archive that stored the file AS a link,
 *   which is the one cause with no link on disk: extractZip records it and writes
 *   nothing, so the corpus never holds a file whose bytes are a path. Where an installed
 *   tree is recorded rather than read, a link named node_modules is that tree and is not
 *   here (see nodeModules); everywhere else every link is. Set by loadAddon only.
 * @property {string[]} [directories]  Posix paths of every directory the walk entered;
 *   empty when none. The file keys cannot answer this: they name files, so a directory is
 *   visible there only as a prefix of one and an EMPTY directory not at all - which is why
 *   a reader asking "is this path a directory in the submission" asks here. A recorded
 *   installed tree is NOT among them: it is not walked, so nothing may resolve into it.
 *   Set by loadAddon only.
 * @property {?Manifest} manifest  Parsed; null if missing/invalid.
 * @property {string} manifestText  Raw manifest.json text ("" if none), parsed onto the
 *   record once so checks read it here rather than re-reading and re-parsing the file.
 * @property {string|null} manifestError     Parse error message, if any.
 * @property {?import("./manifest-loc.js").ManifestLoc} manifestLoc  Resolves a
 *   manifest JSON path to its source line; null when there is no manifest.
 */

/**
 * @param {string} source  Path to an .xpi/.zip file or an unpacked add-on
 *   directory.
 * @param {string} [extractTo]  Where to extract `source` if it is a packed file;
 *   ignored if it is already a directory. Defaults to a fresh `<source>.extracted`
 *   (src/util/dest.js) when omitted - callers that care where it landed (the
 *   review, so it can hand the same folder to a reviewer) pass their own.
 * @param {{recordInstalledTrees?: boolean}} [options]  `recordInstalledTrees` makes a
 *   node_modules directory a RECORDED path instead of content: its paths land in
 *   `nodeModules` and not one of its files is read. Only a submitted SOURCE ARCHIVE asks
 *   for that, because there an installed tree is not part of the submission - the
 *   reviewer installs it - so reading it would review bytes the build replaces. In an
 *   ADD-ON, which is what users receive, a folder called node_modules is shipped content
 *   like any other folder and is loaded and reviewed as one, which is why this is off by
 *   default: the exception is named at the one call that needs it.
 * @returns {Addon}
 */
export function loadAddon(source, extractTo, { recordInstalledTrees } = {}) {
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Add-on not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  let files, nodeModules, archives, skipped, symlinks, directories;
  if (stat.isDirectory()) {
    ({ files, nodeModules, archives, skipped, symlinks, directories } = readDir(
      resolved,
      recordInstalledTrees
    ));
  } else {
    const dest = extractTo ?? extractionDestination(`${resolved}.extracted`);
    // A recorded installed tree and a stored link entry are what extractZip will not put
    // on disk, so they are what the read-back below cannot rediscover there - everything
    // else (files, archives, symlink notices) is real on disk after extraction and is
    // read the same way an already-unpacked submission's is.
    const packed = extractZip(resolved, dest, recordInstalledTrees);
    const unpackedDir = readDir(dest, recordInstalledTrees);
    ({ nodeModules } = packed);
    ({ files, archives, skipped, directories } = unpackedDir);
    // Both halves, so which one can see a link is not a fact this line depends on.
    symlinks = [...packed.symlinks, ...unpackedDir.symlinks];
  }
  // One corpus, because an artifact loaded on its own has nothing to hold back: every file
  // it holds is a file it ships. A SOURCE archive is the exception and says so later
  // (scaViews), which is the only place `files` and `store` come apart.
  const addon = assembleAddon(files);
  addon.store = files;
  addon.nodeModules = nodeModules;
  addon.archives = archives;
  addon.skipped = skipped;
  addon.symlinks = symlinks;
  addon.directories = directories;
  return addon;
}

// The WebExtension manifest's filename, by which one is recognized at any depth.
const MANIFEST_NAME = "manifest.json";

/**
/**
 * Drop every manifest, at any depth, from a corpus - a SOURCE archive's review corpus and
 * nothing else. There the add-on's root is wherever the developer put it, a submission may
 * hold several (a Chrome port beside the Thunderbird one, a committed build output), and
 * reading one back would answer with the PRE-BUILD manifest where ctx.manifest is the
 * shipped one: two plausible answers to one question, one of them silently wrong. A built
 * XPI keeps its manifests, which are just files it ships.
 *
 * Only ever given a VIEW, so the store keeps what the submission contains, and no parsing:
 * the artifact was assembled already and this is the answer it carries.
 * @param {object} files  The view to lift them off.
 */
function liftManifests(files) {
  const manifests = [...files.keys()].filter(
    (key) => key === MANIFEST_NAME || key.endsWith(`/${MANIFEST_NAME}`)
  );
  for (const key of manifests) {
    files.delete(key);
  }
}

/**
 * Build an Addon record over one corpus: parse its ROOT manifest.json (BOM-tolerant, JSON5)
 * onto the record. The corpus is left alone - reading the manifest is not a reason to take
 * it away, and the one corpus that must give its manifests up says so itself
 * (liftManifests, for a source archive).
 * @param {object} files  The corpus to build over. A hand-built Map works too, which is what
 *   the unit fixtures pass.
 * @returns {Addon}
 */
function assembleAddon(files) {
  const addon = {
    files,
    manifest: null,
    manifestText: "",
    manifestError: null,
    manifestLoc: null,
  };
  const manifestBuf = files.get(MANIFEST_NAME);
  if (manifestBuf) {
    addon.manifestText = manifestBuf.toString("utf8");
    let text = addon.manifestText;
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    addon.manifestLoc = buildManifestLoc(text);
    try {
      addon.manifest = JSON5.parse(text);
    } catch (err) {
      addon.manifestError = err.message;
    }
  }
  return addon;
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
 * flags it is handed (including the two that never reach the path math here), and
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
 * PARTITION a source code archive into the three parts a source review reads, as views
 * over the one store the archive was walked into (./corpus.js). Every file is held once,
 * by the store; a view adds the key set it holds. No view re-keys: all three spell a file
 * the way the submission does.
 *
 *   source      everything the archive holds, MINUS the Experiment subtree. The whole of
 *               it, because a build script may put any file anywhere: nothing in the
 *               archive can be assumed unused, so the archive IS the review corpus and
 *               there is no narrower add-on subtree to carve out of it.
 *   experiment  the Experiment implementation at `scaExpSource`, wherever it sits - inside
 *               the source or beside it. Privileged, non-WebExtension code: it is recorded
 *               here ONCE so nothing downstream has to re-derive where it went.
 *   sca         the same files, as a second view. A build may read anything the archive
 *               holds - where a file sits says nothing about whether a step reaches it -
 *               so nothing is withheld from the half that traces the build. An installed
 *               dependency tree never reaches here: loadAddon records the directory paths
 *               for committed-node-modules and reads none of it.
 *
 * The Experiment is disjoint from the other two. Source and build are NOT, and are not
 * meant to be: the tooling is intermingled with the code, each half feeds its own checks,
 * and which of those files the build actually RUNS is narrowed later, off the root
 * package.json (src/build/corpus.js selectBuildCorpus, via analyzeBuild). One pass, one set
 * of prefixes, so no two of them can disagree about where a file went.
 *
 * The source addon is PURE source - its own files and its own manifest.json, which
 * assembleAddon lifts off the corpus. The authoritative manifest is the built XPI's,
 * exposed separately as ctx.manifest (src/checks/context.js); nothing reviews the source
 * manifest.
 *
 * The source and the experiment are keyed alike whenever the Experiment sits inside the
 * add-on, so a check that must review the privileged code too reads the two as one corpus
 * (`source.experiment` carries it onto the review addon for exactly that).
 * @param {Addon} archive  The scaRoot archive, loaded ONCE by the caller (loadAddon).
 * @param {{scaRoot: string, scaExpSource?: string}} where  Absolute paths, resolved by the
 *   arg-array reader (src/cli.js). scaExpSource may sit anywhere under the root.
 * @returns {Addon}  The SAME archive, now carrying its three corpora. Not a new object:
 *   the store, the parsed manifest and the recorded path lists already describe this
 *   submission, and copying them onto parts is how they came to disagree.
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

  // Two views over the ONE key set, because a build may read anything the archive holds:
  // where a file sits says nothing about whether a build step reaches it, and a step the
  // trace cannot see raises no signal for the reviewer to follow. They differ only in that
  // the review corpus gives up its manifests - a pre-build manifest must not be read as the
  // shipped one - which is a fact about that corpus, not about what the archive holds.
  archive.sca = fileView(store, { keys: sourceKeys });
  archive.experiment = fileView(store, { keys: expKeys });
  archive.files = fileView(store, { keys: sourceKeys });
  // Lifted, not re-assembled: loadAddon already parsed this archive's root manifest, and
  // the view holds the same bytes, so parsing again would only produce a second copy of an
  // answer the archive carries.
  liftManifests(archive.files);
  return archive;
}

/** @returns {Error} The add-on-too-large error, shared by extractZip and readDir. */
function addonTooLargeError() {
  const mb = ADDON_MAX_UNPACKED_BYTES / (1024 * 1024);
  return new Error(`Add-on unpacked size exceeds the ${mb} MB limit`);
}

/**
 * One sentence for an archive we cannot read, shared by extractZip's three refusals: the
 * container will not open, an entry name is not one we take, an entry will not inflate.
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
 * a review of it has always applied - only now the validated bytes land on disk
 * instead of in a Map.
 *
 * Never AdmZip's own extractAllTo/extractEntryTo: those replay the archive's OWN
 * claims about each entry (its stored path, its stored Unix mode), which is exactly
 * what isSafeAddonPath exists to refuse rather than trust - and a mode claiming
 * "symlink" would have AdmZip create a real one on disk from bytes we did not
 * write. Every entry here is read with getData() and written with writeFileSync, so
 * what lands on disk is never anything other than the file it claims to be.
 *
 * The mode is still READ, for the one claim worth recording: an entry stored as a link
 * holds a path where a file's bytes belong, so writing it would put a file in the corpus
 * whose whole content is the name of another one. It is recorded and dropped instead.
 *
 * destDir is always this call's own fresh destination (the caller computed it, or
 * defaulted it, right before calling this), so a refusal removes it rather than
 * leaving a partial extraction beside the submission for a reviewer to mistake for
 * the whole thing.
 * @param {string} zipPath  Path to the .xpi/.zip archive.
 * @param {string} destDir  Where to write it. Created if missing.
 * @param {boolean} [recordInstalledTrees]  See loadAddon: record a node_modules entry's
 *   directory as a path instead of extracting it. Off means such an entry is extracted
 *   like any other, which is what a shipped add-on's files are.
 * @returns {{nodeModules: string[], symlinks: {path: string, cause: object}[]}}  What
 *   was skipped and never written - the facts a later read of destDir cannot recover,
 *   because nothing is there to find.
 */
function extractZip(zipPath, destDir, recordInstalledTrees) {
  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch {
    // The container itself: truncated, or not a zip at all.
    throw unreadableArchiveError(zipPath);
  }
  const nodeModules = new Set();
  const symlinks = [];
  let unpacked = 0;
  // Created up front, not only by the first entry's own mkdirSync: an archive with no
  // file entries at all (only directories, or only a node_modules subtree) would
  // otherwise leave nothing here for readDir to walk.
  fs.mkdirSync(destDir, { recursive: true });
  try {
    for (const entry of zip.getEntries()) {
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
      // Where an installed tree is recorded rather than read, record the outer
      // node_modules directory and skip BEFORE getData(), so its contents never enter
      // memory or reach disk. Otherwise the name means nothing here: an add-on's entries
      // are its content whatever directory they sit in, and the size caps around this
      // loop are what keep a large one bounded.
      if (recordInstalledTrees) {
        const segs = name.split("/");
        const nm = segs.indexOf("node_modules");
        if (nm !== -1 && nm < segs.length - 1) {
          nodeModules.add(segs.slice(0, nm + 1).join("/"));
          continue;
        }
      }
      // An entry the archive stored AS a link carries a target path where a file's bytes
      // belong. Record it and skip BEFORE getData(), so the corpus never holds a file
      // whose entire content is the name of another one.
      if (isStoredLink(entry)) {
        symlinks.push({ path: name, cause: SYMLINK_CAUSE.ENTRY });
        continue;
      }
      // Bound decompression against a zip bomb: check the declared size before
      // getData() so a lying-huge header aborts before inflating, then the actual
      // inflated length in case a crafted header under-reports it.
      if (unpacked + entry.header.size > ADDON_MAX_UNPACKED_BYTES) {
        throw addonTooLargeError();
      }
      let data;
      try {
        data = entry.getData();
      } catch {
        // The container opened and the name was fine, but this entry does not inflate: a
        // failed CRC, a damaged stream. The bytes are part of the submission, so a review
        // without them is not a review of it.
        throw unreadableArchiveError(zipPath);
      }
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
  return { nodeModules: [...nodeModules], symlinks };
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
 * @param {boolean} [recordInstalledTrees]  See loadAddon: record a node_modules directory
 *   as a path instead of walking it. Off means it is an ordinary folder, walked and keyed
 *   like any other, which is what a shipped add-on's folders are.
 * @returns {{files: Map<string, Buffer>, nodeModules: string[], archives: string[],
 *   skipped: string[], symlinks: {path: string, cause: object}[],
 *   directories: string[]}}
 */
function readDir(dir, recordInstalledTrees) {
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
        // and the store reads them if something asks (./corpus.js).
        unpacked += fs.statSync(full).size;
        if (unpacked > ADDON_MAX_UNPACKED_BYTES) {
          throw addonTooLargeError();
        }
        keys.push(rel);
      }
    }
  };
  walk(dir);
  return {
    files: new FileStore(dir, keys),
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
  } catch {
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
  // the key the manifest's own reference resolves to (normalizeRefInDir drops both while
  // this loader keeps them), and ".." can additionally point outside the package.
  //
  // entryKey has already stripped a LEADING "./" by this point. That is what `zip -r ./dir`
  // produces, it names the package root unambiguously, and it is the one form repaired
  // rather than refused - the asymmetry is deliberate.
  return !p.split("/").some((s) => s === ".." || s === "." || s === "");
}
