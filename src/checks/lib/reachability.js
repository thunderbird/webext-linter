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
// (custom loaders, odd strings).
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
import {
  warResourceList,
  expandResourcePattern,
  isOverBroadResource,
} from "./web-accessible-resources.js";
import { scanHtmlRemoteRefs } from "../../scan/html.js";
import { scanCssRemoteRefs } from "../../scan/css.js";
import { scanLocalImports } from "../../parse/local-imports.js";
import { scanLoaderRefs } from "../../parse/loader-files.js";
import { nonAuthoredJs } from "./bundled.js";
import { asArray, asObject, PROJECT_METADATA_RE } from "./util.js";
import { extname, JS_EXTENSIONS, HTML_EXTENSIONS } from "../../util/files.js";
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
// Human-readable docs/metadata the add-on never loads at runtime. A path here is
// a prose mention (e.g. a README screenshot), not a loader reference, so - like
// manifest.json - these are excluded from the basename net. Otherwise an asset
// referenced only by a README looks "mentioned" and never gets flagged.
const DOC_FILE = new RegExp(
  `${PROJECT_METADATA_RE.source}|\\.(md|markdown|txt|rst)$`,
  "i"
);

/**
 * @typedef {object} Reachability
 * @property {Set<string>} reachable       Files reachable from any entry point.
 * @property {Set<string>} webReachable    Files reachable from a content script.
 * @property {boolean} hasDynamicLoaders  A live, authored file builds a load path
 *   at run time (dead-code and non-authored/library loaders are excluded).
 * @property {{file: string, kind: string}[]} dynamicLoaderSites  Live, authored.
 * @property {(basename: string, exceptFile?: string) =>
 *   {file: string, line: number}[]} mentionsOf
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
  const files = addon.files;
  const manifest = addon.manifest || {};

  // Non-authored (vendored / library / minified) JS. We still parse it for
  // outgoing edges (so what it statically loads stays reachable), but its own
  // runtime-built loaders are NOT add-on loader sites: a third-party library does
  // not load the add-on's own files, so its dynamic loads must not make every
  // unreferenced add-on file look ambiguous.
  const nonAuthored = nonAuthoredJs(ctx);
  // JS we do NOT parse for outgoing edges. Off by default (see config.js):
  // skipping a non-authored file would drop its loader edges and make the files
  // it loads look unreachable. The finding scanners still skip these themselves.
  const skipParse = REACHABILITY_SKIPS_NON_AUTHORED ? nonAuthored : new Set();

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
    // insertCSS, the register family, setIcon, tabs.create, ... Every path is
    // extension-root-relative.
    const loaded = scanLoaderRefs(
      src.code,
      src.lineOffset,
      ctx.schema,
      ctx.schema?.manifestVersionMajor
    );
    for (const r of loaded.refs) {
      addEdge(src.file, resolveRef(files, null, r.path));
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

  const reachable = bfs(generalSeeds, outEdges);
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
 * The string-find safety net: every text file's lines holding `basename` (a
 * reference the structured parsers may have missed). Excludes `exceptFile` so a
 * file mentioning its own name does not save itself.
 * @param {Map<string, Buffer>} files
 * @returns {(basename: string, exceptFile?: string) =>
 *   {file: string, line: number}[]}
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
      !DOC_FILE.test(file) &&
      TEXT_EXTS.has(extname(file))
    ) {
      lines.set(file, buf.toString("utf8").split("\n"));
    }
  }
  return (basename, exceptFile) => {
    const hits = [];
    for (const [file, ls] of lines) {
      if (file === exceptFile) {
        continue;
      }
      ls.forEach((line, i) => {
        if (line.includes(basename)) {
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
