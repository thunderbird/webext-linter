// A code string passed to setTimeout/setInterval in authored JavaScript - the
// string is eval'd, so it is dynamic code execution, not allowed.
//
// Asked of EVERY artifact the review has (`input: all`, via perArtifact), with the other
// two deterministic dynamic-execution checks it shares a scan with: the question is about
// what ships, and splitting the family across routes would answer it differently depending
// on which of them found the hit.
//
// Belongs here: a finding per code-string-timer hit. Does NOT belong here: the
// scan (-> getEvalScan in src/lib/eval-scan.js, shared with the other
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
      if (hit.type !== "string-timer") {
        continue;
      }
      const loc = { line: hit.line, column: hit.column };
      out.push(finding({ ...ctx.artifact.at(hit.file, loc) }));
      ctx.note?.(
        ctx.artifact.at(hit.file, loc),
        "setTimeout/setInterval(string)",
        VERDICT.FAIL
      );
    }
    return { findings: dedupe(out) };
  }),
};
