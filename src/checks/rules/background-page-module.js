// A background PAGE (manifest background.page, an HTML file) loads its scripts
// via <script> tags. A <script src="x.js"> whose target uses ES module syntax
// (static import/export) only works when the tag is declared type="module";
// without it Thunderbird loads x.js as a classic script and the module syntax
// fails. Errors on each such <script src> tag in the background page.
//
// The sibling check background-module.js covers the background.scripts /
// service_worker forms (module-ness declared by the manifest "type": "module").
// Inline <script> blocks are out of scope here - only external <script src>.
//
// Belongs here: reading background.page, walking its <script src> tags, and
// emitting the finding at the tag. Does NOT belong here: the AST module-syntax
// query (-> lib/module-syntax.js), HTML parsing (-> src/scan/html-parse.js),
// ref resolution (-> resolveRef in lib/manifest-refs.js), authored wording
// (-> assets/registry.yaml), and severity (-> that registry entry).

import { finding } from "../../report/finding.js";
import { parseJs } from "../../parse/ast.js";
import { eachElement } from "../../scan/html-parse.js";
import { usesModuleSyntax } from "../lib/module-syntax.js";
import { normalizeRef, resolveRef } from "../lib/manifest-refs.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const page = ctx.addon.manifest?.background?.page;
    if (typeof page !== "string") {
      return [];
    }
    const pageFile = normalizeRef(page);
    const buf = ctx.addon.files.get(pageFile);
    if (!buf) {
      return []; // a declared-but-absent page is bundled-files' concern
    }

    // The page's external scripts are .js files already parsed once into
    // ctx.jsSources. Reuse that, falling back to parsing the bytes ourselves.
    const sources = new Map((ctx.jsSources ?? []).map((s) => [s.file, s]));
    const out = [];
    eachElement(buf.toString("utf8"), (el) => {
      if (el.tag !== "script") {
        return;
      }
      const src = el.attr("src");
      if (!src) {
        return; // inline <script> - out of scope
      }
      if (el.attr("type")?.trim().toLowerCase() === "module") {
        return; // correctly declared a module
      }
      const target = resolveRef(ctx.addon.files, pageFile, src);
      if (!target) {
        return; // remote or unresolved src - not our concern
      }
      const ast = parsedAst(sources, target, ctx.addon.files);
      if (!ast || !usesModuleSyntax(ast)) {
        return; // a classic script - fine without type="module"
      }
      const loc = { line: el.line };
      ctx.note?.(pageFile, loc, `${src} needs type="module"`, "fail");
      out.push(finding({ file: pageFile, loc }));
    });
    return out;
  },
};

/**
 * The parsed AST for a packaged JS file: the one-time ctx parse when available,
 * else a fresh parse of its bytes. Null when the file is absent or unparsable.
 * @param {Map<string, object>} sources  ctx.jsSources keyed by file.
 * @param {string} file  Add-on-relative path.
 * @param {Map<string, Buffer>} files  The add-on file map.
 * @returns {?object}
 */
function parsedAst(sources, file, files) {
  const src = sources.get(file);
  if (src) {
    return (src.parsed ?? parseJs(src.code)).ast ?? null;
  }
  const buf = files.get(file);
  return buf ? (parseJs(buf.toString("utf8")).ast ?? null) : null;
}
