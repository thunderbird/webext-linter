// The single-parse extraction pass and its read accessors. runExtractionPass
// parses each JS source ONCE, runs every per-file AST extraction on that one AST,
// and stores the small results as `src.extracted` - so a check reads a precomputed
// summary instead of re-traversing (or, once the AST is dropped, re-parsing). The
// AST itself is never retained, so peak memory is a single AST.
//
// api-usage, the load-graph refs (localImports / loaderRefs), and the module-syntax
// loc are extracted on EVERY source; the content results (remote-js, network-sinks,
// ...) only on the developer's own code - a vendored / library / minified / obfuscated bundle is
// non-authored (addon.bundled.nonAuthored) and every content consumer skips it, so
// a multi-MB bundle is never content-scanned. The pass and the consumers read that
// same nonAuthored Set: the pass to decide what to precompute, each consumer to
// decide what to read, so the two never disagree.
//
// The `xOf(src)` accessors are the ONE seam a consumer uses to read a result: each
// returns src.extracted's precomputed value, or recomputes for a source the pass
// never ran on (the shipped view, and hand-built unit contexts). This keeps the
// reuse-or-recompute decision - and each scanner's argument list - in a single
// place rather than repeated at every call site.
//
// Belongs here: orchestrating the per-source parse + the per-concern extractors,
// and the read accessors. Does NOT belong here: the extractors themselves (each
// stays a pure per-concern scanner under src/parse/*) or the non-authored skip set
// (-> src/checks/lib/bundled.js). Babel access goes through src/parse/ast.js.

import { parseJs } from "../parse/ast.js";
import { parseApiUsage } from "../parse/api-usage.js";
import { scanRemoteJs } from "../parse/remote-js.js";
import { scanNetworkSinks } from "../parse/network-sinks.js";
import { scanUnsafeHtml } from "../parse/unsafe-html.js";
import { scanCoreSymbols } from "../parse/core-symbols.js";
import { scanSyncXhr } from "../parse/sync-xhr.js";
import { scanDebugger } from "../parse/debugger-statement.js";
import { scanAsyncOnMessage } from "../parse/async-onmessage.js";
import { scanWebApiCalls, webApiSignatures } from "../parse/web-api-calls.js";
import { scanLocalImports } from "../parse/local-imports.js";
import { scanLoaderRefs } from "../parse/loader-files.js";
import { scanExperimentInjectedRefs } from "../parse/core-loaders.js";
import { obfuscationFrom } from "./lib/bundled.js";
import { firstModuleSyntax } from "./lib/module-syntax.js";

/** @typedef {import("../addon/sources.js").JsSource} JsSource */

/** The parse hint for a source: an explicit `parseAs` override (a Vue <script>
 *  block carries its `lang`) else the file path, whose extension picks the
 *  TypeScript/JSX parse mode. @param {JsSource} src @returns {string} */
const parseHint = (src) => src.parseAs ?? src.file;

/**
 * Parse each source once and store its per-file extraction results on
 * `src.extracted`; the AST is dropped with each iteration.
 * @param {JsSource[]} jsSources
 * @param {object} [opts]
 * @param {import("../schema/index.js").SchemaIndex} [opts.schema]  For the web_api
 *   signatures (the pass scans against ALL of them; the permission grounding
 *   intersects with what the manifest declares) and the loader-ref schema walk.
 * @param {Set<string>} [opts.nonAuthored]  Files a content scanner would skip
 *   (vendored / library / minified / obfuscated / experiment-trusted) -
 *   addon.bundled.nonAuthored, the same Set the consumers read.
 * @param {boolean} [opts.invalidExperiment]  A rejected Experiment runs only the
 *   reject check; nothing reads its content extraction.
 * @param {Set<string>} [opts.experimentNamespaces]  The add-on's Experiment API
 *   namespaces (null for a non-Experiment); present -> extract the injected file
 *   refs on every source, so reachability reads them instead of re-parsing.
 * @param {Set<string>} [opts.obfuscationCandidates]  Files classifyByteGeometry
 *   marked authored-candidates for the AST obfuscation check (JS, non-library,
 *   non-minified, >=1024B); the pass computes each verdict on its shared parse and
 *   records it on src.extracted.obfuscation for assembleBundled to fold in.
 */
export function runExtractionPass(
  jsSources,
  {
    schema,
    nonAuthored,
    invalidExperiment,
    experimentNamespaces,
    obfuscationCandidates,
  } = {}
) {
  const webApiSigs = webApiSignatures(schema);
  const mvMajor = schema?.manifestVersionMajor ?? null;
  for (const src of jsSources) {
    const parsed = parseJs(src.code, parseHint(src));
    // Every source: api-usage (its consumers read ctx.apiUsages) and the load-graph
    // refs (reachability follows a non-authored file's own loaders too).
    const extracted = {
      apiUsage: parseApiUsage(src.code, src.lineOffset, parsed),
      localImports: scanLocalImports(src.code, src.lineOffset, parsed),
      loaderRefs: scanLoaderRefs(
        src.code,
        src.lineOffset,
        schema,
        mvMajor,
        parsed
      ),
      // The first ES module statement's loc (null if none) - the two input:xpi module
      // checks read it via moduleSyntaxOf so they need not re-parse a background script.
      moduleSyntaxLoc: parsed.ast
        ? firstModuleSyntax(parsed.ast, src.lineOffset)
        : null,
    };
    // Experiment-injected file refs (browser.<ns>.…("path")) - every source, only
    // for an Experiment add-on; reachability seeds .html Experiment params from these.
    if (experimentNamespaces) {
      extracted.experimentRefs = scanExperimentInjectedRefs(
        src.code,
        experimentNamespaces,
        src.lineOffset,
        parsed
      );
    }
    // Obfuscation for a byte-geometry candidate (JS, non-library, non-minified),
    // computed on THIS AST so it is comment/string-blind and recorded on
    // extracted.obfuscation for assembleBundled to fold in. A candidate is never a
    // minified/library bundle, so the bundles are never walked here. A definite-yes
    // also gates content out: an obfuscated file is non-authored, the same skip
    // classifyBundled's obfuscated tag produces.
    let obf = false;
    if (obfuscationCandidates?.has(src.file) && !src.inline) {
      const verdict = parsed.parseError ? null : obfuscationFrom(parsed.ast);
      obf = verdict === true;
      extracted.obfuscation = verdict;
    }
    // Content extractors: only the developer's own code. A bundle / library is
    // non-authored and every content consumer skips it (nonAuthoredJs).
    if (!invalidExperiment && !nonAuthored?.has(src.file) && !obf) {
      extracted.remoteJs = scanRemoteJs(src.code, src.lineOffset, parsed);
      extracted.networkSinks = scanNetworkSinks(
        src.code,
        src.lineOffset,
        parsed
      );
      extracted.unsafeHtml = scanUnsafeHtml(src.code, src.lineOffset, parsed);
      extracted.coreSymbols = scanCoreSymbols(src.code, src.lineOffset, parsed);
      extracted.syncXhr = scanSyncXhr(src.code, src.lineOffset, parsed);
      extracted.debuggerStmt = scanDebugger(src.code, src.lineOffset, parsed);
      extracted.asyncOnMessage = scanAsyncOnMessage(
        src.code,
        src.lineOffset,
        parsed
      );
      extracted.webApiPerms = scanWebApiCalls(src.code, webApiSigs, parsed);
    }
    src.extracted = extracted;
    // The AST (`parsed`) goes out of scope with this iteration; src.extracted holds
    // only the small summaries, so peak memory is a single AST.
  }
}

// Read accessors: the precomputed result, or a recompute for a source the pass did
// not run on (the shipped view and hand-built unit contexts). Content accessors are
// only ever called for authored sources (the consumer skips non-authored first);
// the every-source accessors (apiUsage / localImports / loaderRefs) apply to all.

/** @param {JsSource} src */
export const apiUsageOf = (src) =>
  src.extracted?.apiUsage ??
  parseApiUsage(src.code, src.lineOffset, parseJs(src.code, parseHint(src)));
/** @param {JsSource} src */
export const remoteJsOf = (src) =>
  src.extracted?.remoteJs ??
  scanRemoteJs(src.code, src.lineOffset, parseJs(src.code, parseHint(src)));
/** @param {JsSource} src */
export const networkSinksOf = (src) =>
  src.extracted?.networkSinks ??
  scanNetworkSinks(src.code, src.lineOffset, parseJs(src.code, parseHint(src)));
/** @param {JsSource} src */
export const unsafeHtmlOf = (src) =>
  src.extracted?.unsafeHtml ??
  scanUnsafeHtml(src.code, src.lineOffset, parseJs(src.code, parseHint(src)));
/** @param {JsSource} src */
export const coreSymbolsOf = (src) =>
  src.extracted?.coreSymbols ??
  scanCoreSymbols(src.code, src.lineOffset, parseJs(src.code, parseHint(src)));
/** @param {JsSource} src */
export const syncXhrOf = (src) =>
  src.extracted?.syncXhr ??
  scanSyncXhr(src.code, src.lineOffset, parseJs(src.code, parseHint(src)));
/** @param {JsSource} src */
export const debuggerStmtOf = (src) =>
  src.extracted?.debuggerStmt ??
  scanDebugger(src.code, src.lineOffset, parseJs(src.code, parseHint(src)));
/** @param {JsSource} src */
export const asyncOnMessageOf = (src) =>
  src.extracted?.asyncOnMessage ??
  scanAsyncOnMessage(
    src.code,
    src.lineOffset,
    parseJs(src.code, parseHint(src))
  );
/** @param {JsSource} src @param {object[]} signatures */
export const webApiPermsOf = (src, signatures) =>
  src.extracted?.webApiPerms ??
  scanWebApiCalls(src.code, signatures, parseJs(src.code, parseHint(src)));
/** @param {JsSource} src */
export const localImportsOf = (src) =>
  src.extracted?.localImports ??
  scanLocalImports(src.code, src.lineOffset, parseJs(src.code, parseHint(src)));
/** @param {JsSource} src @param {import("../schema/index.js").SchemaIndex} [schema] */
export const loaderRefsOf = (src, schema) =>
  src.extracted?.loaderRefs ??
  scanLoaderRefs(
    src.code,
    src.lineOffset,
    schema,
    schema?.manifestVersionMajor,
    parseJs(src.code, parseHint(src))
  );
/** @param {JsSource} src @param {Set<string>} namespaces  The same namespaces the
 *   pass precomputed with (the review ctx's), so a precomputed hit is correct. */
export const experimentRefsOf = (src, namespaces) =>
  src.extracted?.experimentRefs ??
  scanExperimentInjectedRefs(
    src.code,
    namespaces,
    src.lineOffset,
    parseJs(src.code, parseHint(src))
  );
/** @param {JsSource} src  The loc of the first ES module statement (import/export), or
 *   null if none - precomputed on the shared parse (every source), recomputed for a
 *   source the pass never ran on (the SCA shipped view). */
export const moduleSyntaxOf = (src) => {
  if (src.extracted && "moduleSyntaxLoc" in src.extracted) {
    return src.extracted.moduleSyntaxLoc;
  }
  const { ast } = parseJs(src.code, parseHint(src));
  return ast ? firstModuleSyntax(ast, src.lineOffset) : null;
};
