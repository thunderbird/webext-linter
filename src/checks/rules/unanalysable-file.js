// A JS source Babel parsed but could not walk, so none of its code was analysed. Babel's
// parser recovers from errors its walker cannot model - a `let`, `const` or `class` declared
// twice is the known case - and every such error is an early SyntaxError in every engine and
// bundler: the file can neither run nor be built, and no check saw what it does. One finding
// per source, at the line Babel named, with its reason as the hint.
//
// A `<script>` body the page declares as something other than script (a template, a data
// block) is skipped: the browser never runs it, so it is data that happens to look like
// code, and an add-on is not rejected for shipping it - the rule src/lib/minified.js keeps.
//
// Asked of EVERY artifact the review has (`input: all`, via perArtifact): the failure is
// about the bytes, so it is reported in whichever artifact holds them, and a source review
// does not leave a broken shipped file unsaid.
//
// Belongs here: turning the walk failures the extraction pass recorded (walkFailureOf) into
// findings. Does NOT belong here: telling a walk failure from our own bug (->
// src/parse/ast.js traverse), recording it per file (-> src/checks/extract.js), a file
// Babel could not parse at all (-> unparsable-file.js), wording and severity (->
// assets/registry.yaml).

import { finding } from "../../report/finding.js";
import { walkFailureOf } from "../extract.js";
import { perArtifact } from "../each-artifact.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run: perArtifact((ctx) => {
    const findings = [];
    for (const src of ctx.jsSources) {
      const failure = walkFailureOf(src);
      if (failure && src.declaredJs !== false) {
        const loc =
          failure.line == null ? null : { line: failure.line, column: 0 };
        findings.push(
          finding({ ...ctx.artifact.at(src.file, loc), hint: failure.reason })
        );
      }
    }
    return { findings };
  }),
};
