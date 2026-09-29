// Synchronous XMLHttpRequest: open(method, url, false) - the literal `false`
// third argument makes the request synchronous, blocking the UI thread.
//
// Asked of EVERY artifact the review has (`input: all`, via perArtifact): the request that
// blocks the UI thread is the one in the shipped code, whichever tree it was written in.
//
// Belongs here: skipping non-authored code, then narrating each explicit-async
// open() site (sync = fail, async = pass) and emitting a finding for the sync ones.
// Does NOT belong here: the `.open(...)` AST match (-> src/parse/sync-xhr.js), the
// non-authored skip-list (-> src/lib/bundled.js), authored wording (->
// assets/registry.yaml), severity (-> that registry entry, stamped by
// src/checks/registry.js), and report formatting (-> src/report/format.js).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { syncXhrOf } from "../extract.js";
import { nonAuthoredJs } from "../../lib/bundled.js";

import { perArtifact } from "../each-artifact.js";
export default {
  run: perArtifact((ctx) => {
    const out = [];
    const skip = nonAuthoredJs(ctx); // a library's own sync XHR is not the dev's
    for (const src of ctx.jsSources) {
      if (skip.has(src.file)) {
        continue;
      }
      const { hits } = syncXhrOf(src);
      for (const hit of hits) {
        const loc = { line: hit.line, column: hit.column };
        ctx.note?.(
          ctx.artifact.at(src.file, loc),
          `.open(..., async=${hit.async})`,
          hit.async ? VERDICT.PASS : VERDICT.FAIL
        );
        if (!hit.async) {
          out.push(finding({ ...ctx.artifact.at(src.file, loc) }));
        }
      }
    }
    return { findings: out };
  }),
};
