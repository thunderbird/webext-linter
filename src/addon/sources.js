// Enumerates the JavaScript that ships with an add-on: standalone .js/.mjs
// files plus inline <script> blocks extracted from .html documents. Each
// returned source carries a `lineOffset` so that locations reported by the AST
// map back to the original HTML line. Inline scripts are located with a real
// HTML parser (parse5, via scan/html-parse.js), so the body and its line are
// correct even when a tag's attribute value contains ">".
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
import { extname, JS_EXTENSIONS, HTML_EXTENSIONS } from "../util/files.js";

/**
 * @typedef {object} JsSource
 * @property {string} file  Add-on-relative path (HTML inline scripts keep
 *   the .html path).
 * @property {string} code  JavaScript text.
 * @property {number} lineOffset  Lines to add to AST-reported lines
 *   (0 for .js files).
 * @property {boolean} inline  True if extracted from an HTML <script> block.
 * @property {import("../parse/ast.js").ParseResult} [parsed]  The one-time parse
 *   of `code`, attached by buildRunContext so consumers do not re-parse.
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
    }
  }
  return sources;
}

/**
 * Extract inline <script> bodies from an HTML document. Scripts with a `src`
 * attribute are skipped (the referenced file is covered separately, and a
 * remote src is flagged by the remote-code check). `lineOffset` is one less
 * than the body's start line so AST lines map back to the HTML.
 * @param {string} file  Add-on-relative path of the HTML document.
 * @param {string} html  Full HTML source text.
 * @returns {Array<{file:string,code:string,lineOffset:number,inline:boolean}>}
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
    });
  });
  return out;
}
