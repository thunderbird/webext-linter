// An eval() call in authored JavaScript - dynamic code execution, not allowed.
//
// Asked of EVERY artifact the review has (`input: all`, via perArtifact). The scan covers
// only code OUTSIDE the pure WebExtension tree, because a WebExtension cannot eval without
// a permissive CSP and csp-unsafe-eval reports that separately - so on the shipped side
// this is the Experiment implementation, which a source review otherwise never reads.
//
// Belongs here: a finding per eval() hit. Does NOT belong here: the scan (->
// getEvalScan in src/lib/eval-scan.js, shared with the other
// dynamic-execution checks), authored wording (-> assets/registry.yaml), and
// severity (-> that registry entry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { dedupe } from "../../lib/util.js";
import { getEvalScan } from "../../lib/eval-scan.js";

import { perArtifact } from "../each-artifact.js";
export default {
  run: perArtifact((ctx) => {
    const out = [];
    for (const hit of getEvalScan(ctx).hits) {
      if (hit.type !== "eval") {
        continue;
      }
      const loc = { line: hit.line, column: hit.column };
      out.push(finding({ ...ctx.artifact.at(hit.file, loc) }));
      ctx.note?.(ctx.artifact.at(hit.file, loc), "eval()", VERDICT.FAIL);
    }
    return { findings: dedupe(out) };
  }),
};
