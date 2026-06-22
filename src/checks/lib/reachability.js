// Static reachability over an add-on's files: which packaged files are reached
// from the manifest entry points, following references in HTML
// (<script>/<link>/
// <img>), CSS (@import/url()), and JS (import/require/importScripts, plus every
// file-loading API call - getURL, executeScript/insertCSS, the register family,
// setIcon, tabs.create, ... - extracted by loader-files.js). Two checks share
// this: unused-files (files reachable from ANY entry point) and minimize-web-
// accessible-resources (resources reachable from a WEB-FACING entry point, i.e.
// a content script). Whether library/minified/vendored JS is parsed for edges
// is the REACHABILITY_SKIPS_NON_AUTHORED toggle in src/config.js - off by
// default, so the graph follows edges everywhere (skipping them would hide a
// loader and wrongly orphan what it loads). `hasDynamicLoaders` is set when a
// LIVE (reachable) file builds a load path at runtime (dynamic import/getURL)
// that static analysis can't follow - a loader in dead code never runs, so it
// is dropped. `isLive` says whether a file is reached from any entry point. A
// `mentionsOf` string-find net catches references the structured parsers miss
// (custom loaders, odd strings); it is path-aware, so a reference to a
// same-basename file elsewhere (a library's own button.js) does not make an
// unrelated file look mentioned.
//
// Belongs here: building the reference graph and the Reachability result
// (reachable/webReachable sets, the dynamic-loader flag, mentionsOf), memoized
// per ctx in a WeakMap. The seeding and resolution that need the packaged file
// set.
//
// Does NOT belong here: extracting the edges themselves - HTML/CSS refs come
// from src/scan/html.js and src/scan/css.js, JS imports from
// src/parse/local-imports.js, loader-API paths from src/parse/loader-files.js.
// The manifest ref enumeration - manifest-refs.js. WAR expansion -
// web-accessible-resources.js. The library/vendored leaf set - bundled.js. The
// unused-files and minimize-web-accessible-resources verdicts - their rules
// under src/checks/rules/*.

import { manifestFileRefs, resolveRef } from "./manifest-refs.js";
import { scriptHostDirs, resolvePageRelative } from "./script-hosts.js";
import {
  warResourceList,
  expandResourcePattern,
  isOverBroadResource,
} from "./web-accessible-resources.js";
import { scanHtmlRemoteRefs } from "../../scan/html.js";
import { scanCssRemoteRefs } from "../../scan/css.js";
import { scanLocalImports } from "../../parse/local-imports.js";
import { scanLoaderRefs } from "../../parse/loader-files.js";
import {
  scanCoreLoaderRefs,
  scanExperimentInjectedRefs,
} from "../../parse/core-loaders.js";
import { nonAuthoredJs } from "./bundled.js";
import { asArray, asObject, isExperiment, isDocFile } from "./util.js";
import {
  experimentFileRefs,
  experimentSubtreeRoot,
  experimentApiNamespaces,
  classifyExperimentNamespaces,
} from "./experiments.js";
import {
  basename,
  extname,
  JS_EXTENSIONS,
  HTML_EXTENSIONS,
} from "../../util/files.js";
import { REACHABILITY_SKIPS_NON_AUTHORED } from "../../config.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../../addon/load.js").Manifest} Manifest */

// Files worth scanning for a bare basename mention (the safety net).
const TEXT_EXTS = new Set([
  ...JS_EXTENSIONS,
  ...HTML_EXTENSIONS,
  ".json",
  ".css",
  ".md",
  ".txt",
  ".svg",
  ".xml",
  ".yaml",
  ".yml",
]);
/**
 * @typedef {object} Reachability
 * @property {Set<string>} reachable       Files reachable from any entry point.
 * @property {Set<string>} webReachable    Files reachable from a content script.
 * @property {Set<string>} experimentReachable  Files reachable from the Experiment
 *   subtree, following core-code loaders (rootURI.resolve paths + registered
 *   chrome://resource:// URLs matched by file name). This privileged CORE code is
 *   exempt from the schema/permission checks (it does not use the WebExtension
 *   schema or permissions). Empty when the add-on is not an Experiment.
 * @property {boolean} hasDynamicLoaders  A live, authored file builds a load
 *   path at run time (dead-code and non-authored/library loaders are excluded).
 * @property {{file: string, kind: string}[]} dynamicLoaderSites  Live, authored.
 * @property {(file: string) => {file: string, line: number}[]} mentionsOf
 *   Lines in OTHER files that reference `file` by its basename - path-aware: an
 *   occurrence whose surrounding path resolves to a DIFFERENT packaged file (a
 *   same-basename namesake) is not counted.
 * @property {(file: string) => boolean} isLive  Reachable from ANY entry point
 *   (general or web-facing) - tells a check whether a referrer is itself live
 *   code, so a reference from a dead file can be discounted.
 * @property {(roots: Iterable<string>) => Set<string>} closureFrom  The files
 *   reachable from the given roots over the same reference edges (imports,
 *   module loaders, HTML/CSS), roots included - used to gather a file's nested
 *   helper modules.
 */

// One reachability graph per RunContext - both consuming checks share the
// build. Cached in a WeakMap keyed by ctx so the cache stays out of the
// RunContext contract (and dies with the ctx).
const graphs = new WeakMap();

/**
 * Build the reference graph (computed once per ctx, then shared).
 * @param {RunContext} ctx
 * @returns {Reachability}
 */
export function buildReachability(ctx) {
  let graph = graphs.get(ctx);
  if (!graph) {
    graph = compute(ctx);
    graphs.set(ctx, graph);
  }
  return graph;
}

/**
 * @param {RunContext} ctx
 * @returns {Reachability}
 */
function compute(ctx) {
  const { addon } = ctx;
  const files = addon?.files;
  // A context with no files (degenerate / unit harness) has nothing reachable;
  // return an inert graph so every consumer (incl. the API checks) is a no-op.
  if (!files) {
    return {
      reachable: new Set(),
      webReachable: new Set(),
      experimentReachable: new Set(),
      hasDynamicLoaders: false,
      dynamicLoaderSites: [],
      mentionsOf: () => [],
      isLive: () => false,
      closureFrom: () => new Set(),
    };
  }
  const manifest = addon.manifest || {};

  // Non-authored (vendored / library / minified) JS. We still parse it for
  // outgoing edges (so what it statically loads stays reachable), but its own
  // runtime-built loaders are NOT add-on loader sites: a third-party library
  // does not load the add-on's own files, so its dynamic loads must not make
  // every unreferenced add-on file look ambiguous.
  const nonAuthored = nonAuthoredJs(ctx);
  // JS we do NOT parse for outgoing edges. Off by default (see config.js):
  // skipping a non-authored file would drop its loader edges and make the files
  // it loads look unreachable. The finding scanners still skip these themselves.
  const skipParse = REACHABILITY_SKIPS_NON_AUTHORED ? nonAuthored : new Set();

  // Host-page directories per script, for resolving page-relative loader paths
  // (tabs.executeScript/insertCSS/removeCSS {file}) the way Gecko does - against
  // the calling page's base URL, not the extension root.
  const hostDirs = scriptHostDirs(ctx);

  // Outgoing edges: each file -> the resolved package paths it references.
  const outEdges = new Map();
  const dynamicLoaderSites = [];
  /** @param {string} from @param {string|null} p  Edge target, or null. */
  const addEdge = (from, p) => {
    if (!p) {
      return;
    }
    let set = outEdges.get(from);
    if (!set) {
      outEdges.set(from, (set = new Set()));
    }
    set.add(p);
  };

  for (const [file, buf] of files) {
    const ext = extname(file);
    if (HTML_EXTENSIONS.has(ext)) {
      for (const r of scanHtmlRemoteRefs(buf.toString("utf8"))) {
        if (r.klass === "local") {
          addEdge(file, resolveRef(files, file, r.url));
        }
      }
    } else if (ext === ".css") {
      for (const r of scanCssRemoteRefs(buf.toString("utf8"))) {
        if (r.klass === "local") {
          addEdge(file, resolveRef(files, file, r.url));
        }
      }
    }
  }

  for (const src of ctx.jsSources || []) {
    if (skipParse.has(src.file)) {
      continue;
    }
    // JS import/require/importScripts are relative to the importing file.
    const imp = scanLocalImports(src.code, src.lineOffset);
    for (const r of imp.refs) {
      addEdge(src.file, resolveRef(files, src.file, r.path));
    }
    if (imp.hasDynamic && !nonAuthored.has(src.file)) {
      dynamicLoaderSites.push({ file: src.file, kind: "dynamic-import" });
    }
    // File-loading API calls (schema-directed + bridge): getURL, executeScript/
    // insertCSS, the register family, setIcon, tabs.create, ... Most paths are
    // extension-root-relative. The page-relative trio (base:"page") resolves
    // against the calling script's host page directory instead.
    const loaded = scanLoaderRefs(
      src.code,
      src.lineOffset,
      ctx.schema,
      ctx.schema?.manifestVersionMajor
    );
    for (const r of loaded.refs) {
      const target =
        r.base === "page"
          ? resolvePageRelative(files, hostDirs, src.file, r.path)
          : resolveRef(files, null, r.path);
      addEdge(src.file, target);
    }
    if (loaded.hasDynamic && !nonAuthored.has(src.file)) {
      dynamicLoaderSites.push({ file: src.file, kind: "dynamic-loader" });
    }
  }

  // Seeds: the manifest entry points (resolved root-relative).
  const generalSeeds = new Set();
  /** @param {Set<string>} set @param {string} raw  Root-relative seed path. */
  const seed = (set, raw) => {
    const p = resolveRef(files, null, raw);
    if (p) {
      set.add(p);
    }
  };
  for (const { path } of manifestFileRefs(manifest)) {
    seed(generalSeeds, path);
  }
  for (const raw of extraSeeds(manifest)) {
    seed(generalSeeds, raw);
  }
  // A valid Experiment's bundled files are platform entry points, not unused: its
  // schema/parent/child scripts plus every file in its subtree. Collected as a
  // SEPARATE seed set (folded into generalSeeds too) so the Experiment closure
  // below can be queried on its own - to exempt that privileged CORE code from the
  // schema/permission checks. Applies to both the pristine and --allow-experiments
  // cases.
  const experimentSeeds = new Set();
  if (!ctx.invalidExperiment && isExperiment(manifest)) {
    for (const raw of experimentFileRefs(manifest)) {
      seed(experimentSeeds, raw);
    }
    const expRoot = experimentSubtreeRoot(manifest);
    if (expRoot) {
      for (const f of files.keys()) {
        if (f.startsWith(expRoot)) {
          experimentSeeds.add(f);
        }
      }
    }
  }
  for (const f of experimentSeeds) {
    generalSeeds.add(f);
  }
  for (const entry of warResourceList(manifest)) {
    for (const pat of entry.resources) {
      if (isOverBroadResource(pat)) {
        continue; // do not let "*" mark every file as used
      }
      for (const p of expandResourcePattern(files, pat)) {
        generalSeeds.add(p);
      }
    }
  }

  const webSeeds = new Set();
  for (const cs of asArray(manifest.content_scripts)) {
    if (cs && typeof cs === "object") {
      for (const j of asArray(cs.js)) {
        seed(webSeeds, j);
      }
      for (const c of asArray(cs.css)) {
        seed(webSeeds, c);
      }
    }
  }

  // The WebExtension tracer's set, before any core-loader edge: today's reachable.
  const baseReachable = bfs(generalSeeds, outEdges);

  // basename -> packaged files of that name, for references matched by file NAME
  // (registered chrome://resource:// URLs and Experiment-injected names).
  const byBasename = new Map();
  for (const f of files.keys()) {
    const b = basename(f);
    let list = byBasename.get(b);
    if (!list) {
      byBasename.set(b, (list = []));
    }
    list.push(f);
  }
  const srcByFile = new Map((ctx.jsSources || []).map((s) => [s.file, s]));
  // Resolve a {kind, value} ref to packaged files. A name match excludes files the
  // WebExtension tracer already reached, so a name is not mis-attributed to a used
  // file; an unmatched name is a core/app file and yields nothing (never flagged).
  const refTargets = (r) =>
    r.kind === "path"
      ? [resolveRef(files, null, r.value)].filter(Boolean)
      : (byBasename.get(r.value) ?? []).filter((t) => !baseReachable.has(t));

  // Files the add-on hands to an Experiment API. We classify by what the experiment
  // DOES with the parameter (its parent.script): a SUBSCRIPT-LOADED file runs as
  // privileged core code (seed it -> exempt); a file loaded into a WebExtension
  // <browser> stays WebExtension code (ignored here -> still checked); an
  // undetermined one is deferred (seeded/exempt now, plus an `unsure` feed note a
  // later summary-prompt can resolve). Scanned across ALL files, since the
  // registration lives in the add-on's own WebExtension code.
  const webextInjected = new Set();
  if (!ctx.invalidExperiment && isExperiment(manifest)) {
    const classes = classifyExperimentNamespaces(addon);
    const namespaces = experimentApiNamespaces(manifest);
    for (const src of ctx.jsSources || []) {
      for (const r of scanExperimentInjectedRefs(
        src.code,
        namespaces,
        src.lineOffset
      ).refs) {
        const cls = classes.get(r.ns);
        for (const t of refTargets(r)) {
          if (cls === "core" || cls === "unsure") {
            experimentSeeds.add(t); // privileged context -> exempt
            if (cls === "unsure") {
              ctx.note?.(src.file, { line: r.line }, t, "unsure");
            }
          } else if (cls === "webext") {
            // A WebExtension page loaded into a browser: it runs (so not unused),
            // but stays WebExtension code (still API-checked).
            webextInjected.add(t);
          }
        }
      }
    }
  }

  // The Experiment dependency tree: a BFS from the Experiment seeds following the
  // normal edges PLUS the core-code loaders (rootURI.resolve paths, and registered
  // chrome://resource:// URLs matched by file NAME) - scanned ONLY here, on
  // Experiment-tree files. Discovered edges go into outEdges, so the loaded add-on
  // files are reachable (not flagged unused).
  const experimentReachable = new Set();
  if (experimentSeeds.size) {
    const queue = [...experimentSeeds];
    while (queue.length) {
      const f = queue.pop();
      if (experimentReachable.has(f)) {
        continue;
      }
      experimentReachable.add(f);
      for (const e of outEdges.get(f) ?? []) {
        if (!experimentReachable.has(e)) {
          queue.push(e);
        }
      }
      const src = srcByFile.get(f);
      if (!src || skipParse.has(f)) {
        continue;
      }
      for (const r of scanCoreLoaderRefs(src.code, src.lineOffset).refs) {
        for (const t of refTargets(r)) {
          addEdge(f, t);
          if (!experimentReachable.has(t)) {
            queue.push(t);
          }
        }
      }
    }
  }

  // Experiment-loaded files (core and WebExtension alike) join the reachable set so
  // they are not flagged unused.
  const reachable = baseReachable;
  for (const f of experimentReachable) {
    reachable.add(f);
  }
  for (const f of webextInjected) {
    reachable.add(f);
  }
  const webReachable = bfs(webSeeds, outEdges);
  /** @param {string} file @returns {boolean} Reached from any entry point. */
  const isLive = (file) => reachable.has(file) || webReachable.has(file);
  // A dynamic loader only matters if the file that builds the path actually
  // runs: a loader in unreachable (dead) code never executes, so it cannot load
  // anything. Drop dead loader sites so they neither force an escalation nor
  // appear as evidence.
  const liveLoaders = dynamicLoaderSites.filter((s) => isLive(s.file));
  return {
    reachable,
    webReachable,
    experimentReachable,
    hasDynamicLoaders: liveLoaders.length > 0,
    dynamicLoaderSites: liveLoaders,
    mentionsOf: makeMentions(files),
    isLive,
    closureFrom: (roots) => bfs(new Set(roots), outEdges),
  };
}

/** @param {Set<string>} seeds @param {Map<string,Set<string>>} outEdges */
function bfs(seeds, outEdges) {
  const reached = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const f = queue.pop();
    if (reached.has(f)) {
      continue;
    }
    reached.add(f);
    for (const e of outEdges.get(f) ?? []) {
      if (!reached.has(e)) {
        queue.push(e);
      }
    }
  }
  return reached;
}

/**
 * Escape a string for literal use inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a line that contains `target`'s basename could actually reference
 * `target` - as opposed to a DIFFERENT packaged file that happens to share the
 * basename. Each path-like token ending in the basename is resolved (relative to
 * the mentioning file AND root-relative). A token that resolves to some OTHER
 * packaged file points elsewhere. The line refers to `target` UNLESS every such
 * token points elsewhere - a bare basename, an unresolvable token, or one
 * resolving to `target` itself all keep the line (the net stays recall-first).
 * @param {string} line
 * @param {RegExp} tokenRe  Global regex for "<path>basename".
 * @param {string} fromFile  The mentioning file (for relative resolution).
 * @param {string} target  The file whose reference we are looking for.
 * @param {Map<string, Buffer>} files
 * @returns {boolean}
 */
function refersTo(line, tokenRe, fromFile, target, files) {
  tokenRe.lastIndex = 0;
  let sawElsewhere = false;
  let m;
  while ((m = tokenRe.exec(line))) {
    const tok = m[0];
    const rel = resolveRef(files, fromFile, tok);
    const root = resolveRef(files, null, tok);
    if (rel === target || root === target) {
      return true; // explicitly references the target
    }
    if (!rel && !root) {
      return true; // bare / unresolvable token - cannot rule out the target
    }
    sawElsewhere = true; // resolves only to other packaged file(s)
  }
  return !sawElsewhere;
}

/**
 * The string-find safety net: every other text file's lines that reference
 * `file` by its basename (a reference the structured parsers may have missed).
 * Path-aware (see refersTo): an occurrence that resolves to a different
 * same-basename file is not counted, so a vendored `components/button/button.js`
 * reference does not make an unrelated `widgets/button.js` look mentioned.
 * @param {Map<string, Buffer>} files
 * @returns {(file: string) => {file: string, line: number}[]}
 */
function makeMentions(files) {
  // manifest.json is structured config, not a code loader - a path appearing
  // there is a declaration (handled by the seeds), not a "reference", so it must
  // not make every declared resource look mentioned. Documentation files are
  // excluded for the same reason (a README image link is not a runtime load).
  /** @type {Map<string, string[]>} */
  const lines = new Map();
  for (const [file, buf] of files) {
    if (
      file !== "manifest.json" &&
      !isDocFile(file) &&
      TEXT_EXTS.has(extname(file))
    ) {
      lines.set(file, buf.toString("utf8").split("\n"));
    }
  }
  return (target) => {
    const base = basename(target);
    const tokenRe = new RegExp(`[\\w./@-]*${escapeRegExp(base)}`, "g");
    const hits = [];
    for (const [file, ls] of lines) {
      if (file === target) {
        continue; // a file mentioning its own name does not save itself
      }
      ls.forEach((line, i) => {
        if (
          line.includes(base) &&
          refersTo(line, tokenRe, file, target, files)
        ) {
          hits.push({ file, line: i + 1 });
        }
      });
    }
    return hits;
  };
}

/**
 * Add-on-root-relative seed paths beyond manifestFileRefs (icons, action/sidebar
 * icons, dictionaries, theme images).
 * @param {Manifest} manifest
 * @returns {string[]}
 */
function extraSeeds(manifest) {
  const out = [];
  out.push(...Object.values(asObject(manifest.icons)));
  for (const key of [
    "action",
    "browser_action",
    "compose_action",
    "message_display_action",
    "sidebar_action",
  ]) {
    const di = asObject(manifest[key]).default_icon;
    if (typeof di === "string") {
      out.push(di);
    } else {
      out.push(...Object.values(asObject(di)));
    }
  }
  out.push(manifest.sidebar_action?.default_panel);
  out.push(...Object.values(asObject(manifest.dictionaries)));
  out.push(...Object.values(asObject(manifest.theme?.images)));
  return out.filter((p) => typeof p === "string");
}
