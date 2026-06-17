// Every dynamic-code-execution signal in the add-on, gathered once and shared:
// the JS scan (eval / Function constructor / code-string timer / ambiguous
// fetch().then(eval) hits) over authored sources, plus the manifest CSP flags.
// The eval-call / function-constructor / string-timer / csp-unsafe-* checks and
// remote-eval all read this one result, so the AST scan runs a single time per
// review - the same "compute once, checks read it" pattern as
// addon.outboundSinks / addon.bundled.
//
// Belongs here: getEvalScan - running scanRemoteJs over each authored source
// (reusing its parsed AST, skipping non-authored code) and reading the manifest
// CSP, memoized on the addon.
//
// Does NOT belong here: the AST walk (-> src/parse/remote-js.js), CSP parsing
// (-> src/scan/csp.js), the verdicts (-> src/checks/rules/{eval-call,
// function-constructor,string-timer,csp-unsafe-eval,csp-unsafe-inline,
// remote-eval}.js), and the non-authored skip set (-> bundled.js).

import { scanRemoteJs } from "../../parse/remote-js.js";
import { analyzeCsp } from "../../scan/csp.js";
import { nonAuthoredJs } from "./bundled.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

/**
 * @typedef {object} EvalScan
 * @property {{file: string, type: string, line: number, column: number}[]} hits
 *   Each dynamic-execution hit (eval / function-constructor / string-timer /
 *   ambiguous-fetch-eval) found in authored JS, tagged with its file.
 * @property {boolean} unsafeEval  The manifest CSP allows 'unsafe-eval'.
 * @property {boolean} unsafeInline  The manifest CSP allows 'unsafe-inline'.
 */

/**
 * Dynamic-code-execution signals, scanned once and memoized on the addon so the
 * eval-related checks share the result.
 * @param {RunContext} ctx
 * @returns {EvalScan}
 */
export function getEvalScan(ctx) {
  return (ctx.addon.evalScan ??= scan(ctx));
}

/**
 * @param {RunContext} ctx
 * @returns {EvalScan}
 */
function scan(ctx) {
  const skip = nonAuthoredJs(ctx);
  const hits = [];
  for (const src of ctx.jsSources ?? []) {
    if (skip.has(src.file)) {
      continue;
    }
    const { hits: found } = scanRemoteJs(src.code, src.lineOffset, src.parsed);
    for (const hit of found) {
      hits.push({
        file: src.file,
        type: hit.type,
        line: hit.line,
        column: hit.column,
      });
    }
  }
  const csp = analyzeCsp(ctx.addon.manifest);
  return { hits, unsafeEval: csp.unsafeEval, unsafeInline: csp.unsafeInline };
}
