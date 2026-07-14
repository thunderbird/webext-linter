// LLM answers for the permission-recheck-xpi fixture (an XPI review; see
// tests/fake-llm.js). messagesRead, accountsRead and compose each escalate to
// unused-permission-recheck (none is proven used by the deterministic scan), and each
// has a single located SITE the model verdicts by its orchestrator-minted id
// "<permission>#<n>" while seeing the full add-on: relatedMessageId at bg.js:11
// (messagesRead, a bare token), displayedFolder at bg.js:12 (accountsRead, a bare token),
// and messenger.scripting.executeScript at bg.js:13 (compose, a dotted api-resolved
// token). scripting is grounded by that same call and dropped, so it never reaches here.
//
//   messagesRead#1 -> pass  => the permission is exercised there => dropped (justified)
//   accountsRead#1 -> unsure => the model cannot tell => manual review
//   compose#1      -> fail  => not exercised there => a warning finding (unused)
//
// So the three aggregation outcomes: any-site-pass drops, all-fail is a finding, and
// unsure falls to manual.

export const review = {
  summary:
    "Per-occurrence recheck: three declared permissions judged at their token sites.",
  recheckVerdicts: {
    "unused-permission-recheck": {
      "messagesRead#1": "pass",
      "accountsRead#1": "unsure",
      "compose#1": "fail",
    },
  },
};
