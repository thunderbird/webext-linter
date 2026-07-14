// LLM answers for the citation-permission-sca fixture (an SCA review: src/ + xpi/; see
// tests/fake-llm.js). Every declared permission escalates to unused-permission-recheck
// (SCA is deterministically undecidable, so the producer escalates all), and the SOURCE
// summary pass re-judges them - the citation is verified against the SOURCE corpus (the
// recheck's producer artifact, resolved by ctxForRule), which is what that pass numbered:
//
//   messagesRead -> pass, cites relatedMessageId at bg.js:6 (a real source line)
//                   => VERIFIES => dropped (justified)
//   accountsRead -> pass, but cites displayedFolder at bg.js:6, where relatedMessageId
//                   lives => does NOT verify => downgraded to unsure => manual review
//   compose      -> fail => a warning finding
//
// analyzeBuild (callText) also runs, classifying the src/ build corpus as "ok".

export const text =
  '{"classification": "ok", "reason": "builds from source with web-ext", "buildInstructions": "npm run build"}';

export const review = {
  summary:
    "SCA citation demo: three declared permissions re-judged against the source with cited evidence.",
  recheckVerdicts: {
    "unused-permission-recheck": {
      messagesRead: {
        verdict: "pass",
        usages: [{ file: "bg.js", lines: "6", token: "relatedMessageId" }],
      },
      accountsRead: {
        verdict: "pass",
        usages: [{ file: "bg.js", lines: "6", token: "displayedFolder" }],
      },
      compose: "fail",
    },
  },
};
