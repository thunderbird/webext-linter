// LLM answers for the sca-two-pass-llm fixture (see tests/fake-llm.js). This is an SCA
// review (src/ + xpi/), so the add-on summary runs as TWO passes and every setup-time model
// call routes through the fake:
//
//   analyzeBuild (callText): SCA classifies the build corpus (package.json). "ok" = builds
//     from source, no build finding.
//   evaluate: the input:xpi unused-files check judges the orphan file -> unsure, so it is
//     diverted to the unused-files-recheck consumer (XPI-anchored).
//   reviewAddon: the SOURCE pass (over src/, the displayed "Summary of add-on") carries the
//     source-anchored consumers; the PACKAGING pass (over the built XPI, prose discarded)
//     carries the XPI-anchored consumers and re-judges the orphan. keepVerdicts filters each
//     pass's verdicts to its own corpus before they merge. One review descriptor answers
//     both, since recheck is derived from each pass's own prompt.

// The build classification (analyzeBuild). A JSON object reply, per the build-analysis rubric.
export const text =
  '{"classification": "ok", "reason": "builds from source with web-ext", "buildInstructions": "npm run build"}';

// Any evaluate candidate (the orphan unused-file) -> unsure, so it diverts to the recheck.
export const verdictDefault = "unsure";

export const review = {
  summary: "SCA two-pass demo: a Vue component built into a background script.",
  recheckVerdicts: {
    // The packaging pass confirms the orphan is unreachable -> a finding.
    "unused-files-recheck": { "orphan.js": "fail" },
  },
};
