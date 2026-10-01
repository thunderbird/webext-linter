// The single-parse extraction pass and its read accessors. runExtractionPass
// parses each JS source ONCE, runs every per-file AST extraction on that one AST,
// and stores the small results as `src.extracted` - so a check reads a precomputed
// summary instead of re-traversing (or, once the AST is dropped, re-parsing). The
// AST itself is never retained, so peak memory is a single AST.
//
// api-usage, the Web/DOM API grounding, the load-graph refs (localImports / loaderRefs)
// and the module-syntax loc are extracted on EVERY source - because a permission is USED,
// and a file IS loaded, whoever wrote the code (a vendored library's navigator.clipboard
// call grounds clipboardWrite too). The CONTENT results (remote-js, network-sinks, unsafe-
// HTML, ...) are extracted for every source too. WHETHER a non-authored file's hits reach
// the report is a separate question, and the answer is each consumer's: a vendored /
// library / minified / obfuscated bundle is non-authored (addon.bundled.nonAuthored) and
// every content consumer skips it. The policy is stated once, where it is applied, rather
// than also deciding what gets computed - so a consumer can never read a field the pass
// declined to produce.
//
// runExtractionPass is the single full pass, run once per artifact: the review target, and
// - in an SCA review - the built XPI too (both get the same load graph, api-usage and
// content scans), so an input:xpi check sees the XPI analysed the same way in either mode.
//
// The `xOf(src)` accessors are the ONE seam a consumer uses to read a result, and they
// are PURE READS - parsing inside one would put an AST in the check's call stack and
// break both the single-AST memory bound and the "two checks asking the same question
// always agree" guarantee (see resultsOf).
//
// Belongs here: orchestrating the per-source parse + the per-concern extractors,
// and the read accessors. Does NOT belong here: the extractors themselves (each
// stays a pure per-concern scanner under src/parse/*) or the non-authored skip set
// (-> src/lib/bundled.js). Babel access goes through src/parse/ast.js.

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
import { scanCodeText } from "../parse/code-tokens.js";
import { firstModuleSyntax } from "../lib/module-syntax.js";

/** @typedef {import("../addon/sources.js").JsSource} JsSource */

/** The parse hint for a source: an explicit `parseAs` override (a Vue <script>
 *  block carries its `lang`) else the file path, whose extension picks the
 *  TypeScript/JSX parse mode. @param {JsSource} src @returns {string} */
const parseHint = (src) => src.parseAs ?? src.file;

/**
 * The LOAD-GRAPH facts, extracted from an AST the caller already holds: the refs
 * reachability follows (local imports, the schema's loader calls, and an Experiment's
 * injected file refs) plus the first ES-module statement's loc (the two input:xpi module
 * checks read it via moduleSyntaxOf). Every artifact needs these, whatever its role: the
 * full pass extracts them for the review target, and - in an SCA review - for the built XPI
 * too (both go through runExtractionPass), alongside the api-usage and content results.
 * @param {JsSource} src
 * @param {object} parsed  The AST the caller parsed; it drops it after this returns.
 * @param {object} opts
 * @returns {object} The `src.extracted` seed.
 */
function extractLoadGraph(
  src,
  parsed,
  { schema, mvMajor, experimentNamespaces }
) {
  const extracted = {
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
  return extracted;
}

/**
 * The one full pass, run once per artifact - the review target, and in an SCA review the
 * built XPI too. Parse each source once and store its per-file extraction results on
 * `src.extracted`; the AST is dropped with each iteration. On top of the load graph it
 * extracts api-usage and runs the content scanners on every source.
 * @param {JsSource[]} jsSources
 * @param {object} [opts]
 * @param {import("../schema/index.js").SchemaIndex} [opts.schema]  For the web_api
 *   signatures (the pass scans against ALL of them; the permission grounding
 *   intersects with what the manifest.json declares) and the loader-ref schema walk.
 * @param {Set<string>} [opts.nonAuthored]  Files that are not the developer's own
 *   (vendored / library / minified / obfuscated) -
 *   addon.bundled.nonAuthored, the same Set the consumers read. Used here for
 *   `codeAtoms` alone, whose absence routes the token scan to its raw-text path;
 *   every other result is extracted whether or not a file is in it.
 * @param {Set<string>} [opts.experimentNamespaces]  The add-on's Experiment API
 *   namespaces (null for a non-Experiment); present -> extract the injected file
 *   refs on every source, so reachability reads them instead of re-parsing.
 */
export function runExtractionPass(
  jsSources,
  { schema, nonAuthored, experimentNamespaces } = {}
) {
  const webApiSigs = webApiSignatures(schema);
  const mvMajor = schema?.manifestVersionMajor ?? null;
  for (const src of jsSources) {
    const parsed = parseJs(src.code, parseHint(src));
    const extracted = extractLoadGraph(src, parsed, {
      schema,
      mvMajor,
      experimentNamespaces,
    });
    // Every source: api-usage (its consumers read ctx.apiUsages), and the Web/DOM API
    // grounding. webApiPerms is EVERY source, not just the authored ones: a permission is
    // used if the shipped code calls its API, and a vendored library calling
    // navigator.clipboard grounds clipboardWrite just as the developer's own file would.
    // Scanned against ALL web_api signatures; groundWebApiPermissions keeps the declared.
    extracted.apiUsage = parseApiUsage(src.code, src.lineOffset, parsed);
    extracted.webApiPerms = scanWebApiCalls(src.code, webApiSigs, parsed);
    // Content extractors: EVERY source, whoever wrote it. Whether a non-authored file's
    // hits are reported is the consumer's call, and each one makes it for itself against
    // the same nonAuthored Set. Producing the result either way is what stops the two
    // from disagreeing: a consumer that forgot to skip reads real hits, never an
    // `undefined` that throws and takes every check sharing that scan down with it.
    extracted.remoteJs = scanRemoteJs(src.code, src.lineOffset, parsed);
    extracted.networkSinks = scanNetworkSinks(src.code, src.lineOffset, parsed);
    extracted.unsafeHtml = scanUnsafeHtml(src.code, src.lineOffset, parsed);
    extracted.coreSymbols = scanCoreSymbols(src.code, src.lineOffset, parsed);
    extracted.syncXhr = scanSyncXhr(src.code, src.lineOffset, parsed);
    extracted.debuggerStmt = scanDebugger(src.code, src.lineOffset, parsed);
    extracted.asyncOnMessage = scanAsyncOnMessage(
      src.code,
      src.lineOffset,
      parsed
    );
    // The one exception, and not for cost: the code-text atoms (identifiers/strings/
    // templates, comments excluded) with their source lines, which the unused-permission
    // token scan reads to test presence AND point the reviewer at each occurrence. Their
    // ABSENCE is what selects the other path - a non-authored bundle is searched raw
    // instead (permissions.js reads `if (atoms)`), where including comments only pushes
    // toward escalation, the safe direction. Producing them here would quietly move that
    // scan off the conservative branch.
    if (!nonAuthored?.has(src.file)) {
      extracted.codeAtoms = scanCodeText(
        src.code,
        src.lineOffset,
        parsed
      ).atoms;
    }
    src.extracted = extracted;
    // The AST (`parsed`) goes out of scope with this iteration; src.extracted holds
    // only the small summaries, so peak memory is a single AST.
  }
}

/**
 * The per-file results an extraction pass stored on a source. A CHECK IS A PURE READER: it
 * never parses, so a source that reaches a check without having been through a pass is a
 * wiring bug in setup, not something to paper over by parsing here. Fail loudly instead.
 *
 * A field being ABSENT is a different thing, and legitimate: `codeAtoms` on a non-authored
 * source, `experimentRefs` on a non-Experiment add-on. Everything else is on every source.
 * @param {JsSource} src
 * @returns {object}
 */
const resultsOf = (src) => {
  if (!src.extracted) {
    throw new Error(
      `${src.file}: read before the extraction pass ran - a check is a pure reader, it never parses`
    );
  }
  return src.extracted;
};

/** @param {JsSource} src */
export const apiUsageOf = (src) => resultsOf(src).apiUsage;
/** @param {JsSource} src */
export const remoteJsOf = (src) => resultsOf(src).remoteJs;
/** @param {JsSource} src */
export const networkSinksOf = (src) => resultsOf(src).networkSinks;
/** @param {JsSource} src */
export const unsafeHtmlOf = (src) => resultsOf(src).unsafeHtml;
/** @param {JsSource} src */
export const coreSymbolsOf = (src) => resultsOf(src).coreSymbols;
/** @param {JsSource} src */
export const syncXhrOf = (src) => resultsOf(src).syncXhr;
/** @param {JsSource} src */
export const debuggerStmtOf = (src) => resultsOf(src).debuggerStmt;
/** @param {JsSource} src */
export const asyncOnMessageOf = (src) => resultsOf(src).asyncOnMessage;
/** @param {JsSource} src */
export const webApiPermsOf = (src) => resultsOf(src).webApiPerms;
/** @param {JsSource} src */
export const localImportsOf = (src) => resultsOf(src).localImports;
/** @param {JsSource} src */
export const loaderRefsOf = (src) => resultsOf(src).loaderRefs;
/** @param {JsSource} src */
export const experimentRefsOf = (src) => resultsOf(src).experimentRefs;
/** @param {JsSource} src  The loc of the first ES module statement (import/export), or
 *   null if none. */
export const moduleSyntaxOf = (src) => resultsOf(src).moduleSyntaxLoc;
/** @param {JsSource} src  The comment-free code-text atoms with their source lines
 *   for an AUTHORED source, or null for a non-authored bundle (which the pass does
 *   not scan into atoms - locate its tokens over the raw text instead). */
export const codeAtomsOf = (src) => resultsOf(src).codeAtoms ?? null;
