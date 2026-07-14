// LLM answers for the citation-permission-xpi fixture (an XPI review; see
// tests/fake-llm.js). Its three declared permissions each escalate to
// unused-permission-recheck (the require-citation consumer), and the model's `pass`
// must cite evidence the phase verifies against the numbered corpus
// (src/lib/citation.js):
//
//   messagesRead -> pass, cites relatedMessageId at bg.js:6 (a real live-code line)
//                   => the citation VERIFIES => the permission is dropped (justified)
//   accountsRead -> pass, but cites displayedFolder at bg.js:6, where relatedMessageId
//                   - not displayedFolder - lives => the citation does NOT verify
//                   => downgraded to unsure => manual review
//   compose      -> fail => a warning finding (the permission is unused)
//
// So one verified pass, one ungrounded pass caught, and one fail - the three outcomes
// the citation gate must produce.

export const review = {
  summary:
    "Citation demo: three declared permissions re-judged with cited evidence.",
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
