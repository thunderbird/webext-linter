// LLM answers for the permission-recheck-sca fixture (an SCA review: src/ + xpi/; see
// tests/fake-llm.js). unused-permission is input:xpi, so it judges the SHIPPED build
// (xpi/background.js). messagesRead / accountsRead have bare property tokens (relatedMessageId /
// displayedFolder) present in the minified build, so they escalate and the shipped-package
// summary pass re-judges them PER OCCURRENCE (id "<permission>#<n>"):
//
//   messagesRead#1 -> pass  => exercised there => dropped (justified)
//   accountsRead#1 -> unsure => cannot tell => manual review
//
// compose's dotted injection token never appears in the shipped build and the scan is decidable
// (minified, not obfuscated), so compose is a DETERMINISTIC unused-permission finding - it never
// reaches the recheck, so there is no verdict for it here.
//
// analyzeBuild (callText) also runs, classifying the src/ build corpus as "ok".

export const text =
  '{"classification": "ok", "reason": "builds from source with web-ext", "buildInstructions": "npm run build"}';

export const review = {
  summary:
    "Shipped-package recheck: per-occurrence for the property tokens in the built XPI.",
  recheckVerdicts: {
    "unused-permission-recheck": {
      "messagesRead#1": "pass",
      "accountsRead#1": "unsure",
    },
  },
};
