// Rejects (and, as the first check, aborts the review for) an Experiment add-on the
// Experiment verdict rejects: one whose experiment is NOT a recognised published Thunderbird
// API draft - an `unsupported` experiment (an unknown API name, which includes one that
// shadows a built-in) - when the reviewer did not allow Experiments. Recognised-but-modified
// experiments pass here and are reviewed normally, where experiment-modified flags them.
//
// Belongs here: turning the groups the verdict rejected (ctx.experiments, each marked
// `rejected` by src/experiments/verify.js experimentVerdict) into one finding per group, and
// refining the reason to "shadows a built-in" when its declared path resolves to a real API
// (ctx.schema.resolveApi). Does NOT belong here: deciding what is rejected - the verdict is
// the one reader of --allow-experiments, so a check reading the flag could disagree with
// the mode the review was given - detecting Experiment status (isExperiment), classifying
// the files, authored heading wording (assets/registry.yaml), or severity (that registry
// entry, stamped by src/checks/registry.js).
//
// Reads no artifact: the records it asks are the built XPI's whatever the review mode,
// which is why the registry entry declares `input: xpi` (see VALID_CHECK_INPUTS in
// src/checks/registry-vocabulary.js).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { isExperiment, skipWithoutManifest } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const m = ctx.manifest?.json;
    if (!m) {
      return skipWithoutManifest(ctx);
    }
    if (!isExperiment(m)) {
      ctx.note?.(ctx.manifest.locus(), "not an Experiment", VERDICT.PASS);
      return { findings: [] };
    }
    const rejected = (ctx.experiments?.groups ?? []).filter((g) => g.rejected);
    if (rejected.length === 0) {
      ctx.note?.(ctx.manifest.locus(), "no experiment rejected", VERDICT.PASS);
      return { findings: [] };
    }

    const findings = [];
    for (const g of rejected) {
      // The group's OWN declaration, not the experiment_apis block it sits in: a manifest
      // may declare several, and the reviewer needs the one being refused.
      const at = ctx.manifest.locus("experiment_apis", g.key);
      const shadow = firstShadow(ctx.schema, g.apiPaths);
      const reason = shadow
        ? `the ${shadow.path} API shadows the built-in ${shadow.builtin} API`
        : `the ${g.name} API is not a published Thunderbird API draft`;
      ctx.note?.(
        at,
        `${g.name} (${shadow ? "shadows built-in" : "unsupported"})`,
        VERDICT.FAIL
      );
      findings.push(finding({ ...at, hint: reason }));
    }
    return { findings };
  },
};

/**
 * The first declared path that grafts onto a built-in, with the built-in
 * namespace it collides with, or null. A path resolving to anything other than a
 * genuinely-new API (unknown-namespace) or a registered experiment means it
 * overrides/extends a built-in.
 * @param {import("../../schema/index.js").SchemaIndex} schema
 * @param {string[]} [apiPaths]
 * @returns {?{path: string, builtin: string}}
 */
function firstShadow(schema, apiPaths) {
  for (const p of apiPaths || []) {
    const res = schema.resolveApi(p.split("."));
    if (res.kind !== "unknown-namespace" && res.kind !== "experiment") {
      return { path: p, builtin: res.namespace ?? p.split(".")[0] };
    }
  }
  return null;
}
