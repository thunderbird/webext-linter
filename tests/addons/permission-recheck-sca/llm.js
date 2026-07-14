// LLM answers for the permission-recheck-sca fixture (an SCA review: src/ + xpi/; see
// tests/fake-llm.js). Every declared permission escalates to unused-permission-recheck
// (SCA disables the deterministic "unused" finding because source may not equal shipped).
// The SOURCE summary pass re-judges each. messagesRead / accountsRead have bare property
// tokens found in the source, so they are judged PER OCCURRENCE (id "<permission>#<n>");
// compose has dotted (api-resolved) injection tokens but no injection call resolves in
// the non-entry-point source, so it has no site and is judged HOLISTICALLY (keyed by the
// permission itself). The three aggregation outcomes:
//
//   messagesRead#1 -> pass  => exercised there => dropped (justified)
//   accountsRead#1 -> unsure => cannot tell => manual review
//   compose (holistic) -> fail => not used anywhere => a warning finding
//
// analyzeBuild (callText) also runs, classifying the src/ build corpus as "ok".

export const text =
  '{"classification": "ok", "reason": "builds from source with web-ext", "buildInstructions": "npm run build"}';

export const review = {
  summary:
    "SCA recheck: per-occurrence for the property tokens, holistic for the dotted compose token.",
  recheckVerdicts: {
    "unused-permission-recheck": {
      "messagesRead#1": "pass",
      "accountsRead#1": "unsure",
      compose: "fail",
    },
  },
};
