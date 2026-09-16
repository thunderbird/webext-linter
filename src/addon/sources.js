// Enumerates the JavaScript an add-on carries: standalone .js/.mjs/.ts/.tsx/.jsx
// files, inline <script> blocks extracted from .html documents, and the scripts
// and template binding expressions of .vue single-file components. Each returned
// source carries a `lineOffset` so that locations reported by the AST map back to
// the original line of its host file. Inline scripts and SFC blocks are located
// with a real HTML parser (parse5, via scan/html-parse.js), so the body and its
// line are correct even when a tag's attribute value contains ">".
//
// Belongs here: source enumeration - deciding which files are JS and producing
// the JsSource list (with code, lineOffset, inline) the parse/checks layers
// iterate.
//
// Does NOT belong here: parsing the JS into an AST, which is src/parse/ast.js.
// Loading the add-on into the Addon model is src/addon/load.js. The parse5
// element walk it uses lives in src/scan/html-parse.js. Path/extension helpers
// (extname, JS_EXTENSIONS) are src/util/files.js.

import { eachElement } from "../scan/html-parse.js";
import { extractVueSfc } from "../scan/vue-sfc.js";
import {
  extname,
  JS_EXTENSIONS,
  HTML_EXTENSIONS,
  SFC_EXTENSIONS,
} from "../util/files.js";

/**
 * @typedef {object} JsSource  A JavaScript source the review enumerates.
 * @property {string} file  Add-on-relative path (HTML inline scripts keep
 *   the .html path).
 * @property {string} code  JavaScript text.
 * @property {number} lineOffset  Lines to add to AST-reported lines
 *   (0 for .js files).
 * @property {boolean} [inline]  True if extracted from a <script> BODY - an HTML inline
 *   script or an SFC block. Not set for code a scanner lifts out of an attribute:
 *   that is synthesized, so a consumer judging what the add-on ships must not see it.
 * @property {boolean} [declaredJs]  Whether the tag declares this body as JavaScript,
 *   i.e. whether a browser would RUN it (see JS_SCRIPT_TYPES). Set on inline bodies;
 *   a .js file needs no declaration. Read where an unparsable body has to fall one way
 *   or the other - declared JS that will not parse is suspicious, a template or a JSON
 *   blob that will not parse is just not JavaScript.
 * @property {string} [parseAs]  An extension (".ts"/".tsx"/...) that overrides the
 *   parse mode picked from `file`; set for a Vue <script> block, whose mode comes
 *   from its `lang` attribute rather than the ".vue" path.
 * @property {ExtractedResults} [extracted]  The per-file extraction results, set
 *   by an extraction pass (src/checks/extract.js) and read through its xOf()
 *   accessors. A CHECK NEVER PARSES: the accessors THROW on a source no pass ran, rather
 *   than recompute. runExtractionPass sets every field below; it runs once per artifact -
 *   the review target, and in an SCA review the built XPI too (so its input:xpi checks read
 *   the same load graph + api-usage a native XPI review would produce).
 */

/**
 * @typedef {object} ExtractedResults  The per-source results the full extraction pass
 *   hangs on src.extracted (having dropped the AST). Whether a source is AUTHORED
 *   is visible in the shape: the every-source fields are always present; the
 *   content fields only when authored (a non-authored bundle / library is skipped).
 *   The light shipped pass sets only the load-graph subset (see JsSource.extracted).
 * @property {import("../parse/api-usage.js").ApiUsageResult} apiUsage  WebExtension
 *   API usage (ctx.apiUsages is derived from it; its parseError feeds unparsable-file)
 *   - every source.
 * @property {object} localImports  scanLocalImports import/require refs - every
 *   source (reachability follows a non-authored file's own loaders too).
 * @property {object} loaderRefs  scanLoaderRefs file-loading API refs - every source.
 * @property {?{line: number, column: number}} moduleSyntaxLoc  first ES module
 *   statement loc, or null - every source (the two input:xpi module checks read it).
 * @property {object} [experimentRefs]  scanExperimentInjectedRefs refs - every
 *   source, but only for an Experiment add-on (absent otherwise).
 * @property {object} [remoteJs]  scanRemoteJs (eval-scan + remote-resources) - authored.
 * @property {object} [networkSinks]  scanNetworkSinks (outbound-sinks) - authored.
 * @property {object} [unsafeHtml]  scanUnsafeHtml - authored.
 * @property {object} [coreSymbols]  scanCoreSymbols (core-symbol-in-webext) - authored.
 * @property {object} [syncXhr]  scanSyncXhr (sync-xhr) - authored.
 * @property {object} [debuggerStmt]  scanDebugger (debugger-statement) - authored.
 * @property {object} [asyncOnMessage]  scanAsyncOnMessage (async-onmessage) - authored.
 * @property {Set<string>} [webApiPerms]  scanWebApiCalls grounded permissions
 *   (against ALL web_api signatures; the consumer intersects with declared) - EVERY source
 *   (a vendored library's navigator.* call grounds the permission just as authored code does).
 * @property {{value: string, line: number}[]} [codeAtoms]  scanCodeText comment-free
 *   code-text atoms with their source lines, for the unused-permission token scan
 *   (presence + occurrence location) - authored only (non-authored searched raw).
 */

/**
 * @param {import("./load.js").Addon} addon
 * @returns {JsSource[]}
 */
export function collectJsSources(addon) {
  const sources = [];
  for (const [file, buf] of addon.files) {
    const ext = extname(file);
    if (JS_EXTENSIONS.has(ext)) {
      sources.push({
        file,
        code: buf.toString("utf8"),
        lineOffset: 0,
        inline: false,
      });
    } else if (HTML_EXTENSIONS.has(ext)) {
      sources.push(...extractInlineScripts(file, buf.toString("utf8")));
    } else if (SFC_EXTENSIONS.has(ext)) {
      sources.push(...extractVueSfc(file, buf.toString("utf8")));
    }
  }
  return sources;
}

// The `type` values a browser EXECUTES as a classic script, per the HTML spec's
// JavaScript MIME types, plus the two that mean "no type given". A tag with any other
// type - text/template, application/json, importmap, ld+json - is data: the browser
// never runs it. The list is only ever used to decide which way an UNPARSABLE body
// falls, never what gets extracted, so a spelling missing from it cannot blind a scan:
// anything that parses is judged whatever its type says.
const JS_SCRIPT_TYPES = new Set([
  "",
  "module",
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

/**
 * Whether a `<script type=...>` value declares JavaScript. Absent counts; the value is
 * compared as the spec does - trimmed, lowercased, parameters (";charset=") dropped.
 * @param {?string} type  The raw attribute value, or null when absent.
 * @returns {boolean}
 */
function declaresJs(type) {
  if (type === null || type === undefined) {
    return true;
  }
  return JS_SCRIPT_TYPES.has(type.split(";")[0].trim().toLowerCase());
}

/**
 * Extract inline <script> bodies from an HTML document. Scripts with a `src`
 * attribute are skipped (the referenced file is covered separately, and a
 * remote src is flagged by the remote-code check). `lineOffset` is one less
 * than the body's start line so AST lines map back to the HTML.
 * @param {string} file  Add-on-relative path of the HTML document.
 * @param {string} html  Full HTML source text.
 * @returns {Array<{file:string,code:string,lineOffset:number,inline:boolean,declaredJs:boolean}>}
 */
function extractInlineScripts(file, html) {
  const out = [];
  eachElement(html, (el) => {
    if (el.tag !== "script" || el.attr("src") !== null || !el.rawText) {
      return;
    }
    if (el.rawText.value.trim() === "") {
      return;
    }
    out.push({
      file,
      code: el.rawText.value,
      lineOffset: el.rawText.startLine - 1,
      inline: true,
      declaredJs: declaresJs(el.attr("type")),
    });
  });
  return out;
}
