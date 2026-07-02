// LLM check (SCS only): in source-code-submission mode the reviewer BUILDS the
// add-on from the readable source, but the dependency audit only reads the root
// package.json/lock. A build script or config could ignore package.json and pull
// code/resources from an UNDECLARED source (a raw URL, curl|sh, a git clone of an
// unpinned repo, a CDN, a postinstall hook), leaving package.json a clean decoy.
//
// ALL the build files are judged TOGETHER (one candidate, whole corpus) for one
// structured verdict - the report_verdicts result {verdict, reason,
// additionalInformation}: reason = a prose explanation of the build + any external
// sources, additionalInformation = the steps to build the XPI. This check carries NO
// user-facing prose: it emits only the verdict-derived data slots {explanation,
// buildInstructions}, and the wording lives in assets/registry.yaml (response +
// instructions). A fail WITH a reason -> an error finding (registry response); a fail
// with no reason, pass, or unsure -> extended manual review (registry instructions +
// response). Offline (no token) needs
// no special case: the check still returns its llm step and the orchestrator's
// no-token path defaults the candidate to unsure -> the manual lane, exactly like
// data-exfiltration degrades offline.
//
// The check declares `input: build`, so the orchestrator routes ctx.addon to the
// build files (buildScsBuildCtx: every file outside the review source, the Experiment
// source, node_modules, and dotfiles - see loadScsBuildFiles) - read like any other
// check reads its artifact, and fed to the model through the normal evaluate path
// (framing + wrapFile injection defense, identical to the llm-summary).
//
// The WHOLE build corpus is judged: which files count as build files is a pure exclude
// rule in loadScsBuildFiles, so there is nothing to select here - the check sends every
// file it is routed.
//
// Belongs here: mapping the one verdict to finding/manual data. Does NOT belong here:
// loading + selecting the build files (-> src/addon/load.js loadScsBuildFiles), the
// model transport + injection wrapping (-> src/checks/llm-client.js), or ANY wording
// (-> the registry).

import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], llm?: import("../escalation.js").LlmStep}}
   */
  run(ctx) {
    // input: build - the orchestrator routed ctx.addon to the build files
    // (loadScsBuildFiles already excluded the review source, the Experiment source,
    // node_modules, and dotfiles). No files left -> nothing to review.
    const build = ctx.addon;
    if (!build?.files?.size) {
      return { findings: [] };
    }
    // One whole-build judgment over the ENTIRE routed corpus, read from ctx.addon by
    // the normal evaluate path. Anchor at package.json (the build manifest) if present,
    // else the first file. Offline (no token) -> runLlmCheck defaults the candidate to
    // unsure -> the manual lane.
    const corpus = [...build.files.keys()];
    const anchor = build.files.has("package.json") ? "package.json" : corpus[0];
    ctx.note?.(anchor, null, "the build configuration", "unsure");
    return {
      findings: [],
      llm: {
        candidates: [
          {
            id: "BUILD",
            file: anchor,
            note: "the build configuration",
            corpus,
          },
        ],
        resolve: resolveBuild(anchor),
      },
    };
  },
};

/**
 * The one whole-build verdict -> outcome, carrying only data slots (no prose - the
 * registry owns the wording, which is authored to read with empty slots). A `fail`
 * WITH a substantiating reason = an error finding whose response uses {{explanation}}.
 * A `fail` with no reason, `pass`, `unsure` (and offline, where the candidate defaults
 * to unsure) = an extended manual-review note whose instructions/response use
 * {{explanation}} + {{buildInstructions}}. The model's reason/additionalInformation
 * pass through raw ("" when absent).
 * @param {string} anchor  The file the finding / manual note anchors at.
 * @returns {(verdicts: Map<string, {verdict: string, reason: ?string,
 *   additionalInformation?: string}>) => {findings: object[], manual: object[]}}
 */
function resolveBuild(anchor) {
  return (verdicts) => {
    const v = verdicts.get("BUILD");
    // Defensive coercion: coerceResult forces reason to string|null on the live path,
    // but this is the only reason.trim()-style check in the codebase, so a non-string
    // reason (an injected/stubbed verdict) must not crash it.
    const explanation = typeof v?.reason === "string" ? v.reason : "";
    // A fail must carry a substantiating reason (the finding anchors at the manifest,
    // so the reason is its only account of what is undeclared); a reason that is empty,
    // whitespace, or only zero-width characters cannot, so route it to manual review.
    const substantiated = /[^\s\u200b-\u200d\u2060\ufeff]/u.test(explanation);
    if (v?.verdict === "fail" && substantiated) {
      return {
        findings: [finding({ file: anchor, data: { explanation } })],
        manual: [],
      };
    }
    return {
      findings: [],
      manual: [
        {
          file: anchor,
          data: {
            explanation,
            buildInstructions: v?.additionalInformation ?? "",
          },
        },
      ],
    };
  };
}
