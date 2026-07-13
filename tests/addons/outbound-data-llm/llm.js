// LLM answers for the outbound-data-llm fixture (see tests/fake-llm.js). Its presence
// turns --llm-review on for this fixture and drives the model paths deterministically. It
// exercises both LLM lanes and all three recheck verdicts the post-summary phase maps:
//
//   evaluate (the data-exfiltration llm-phase check judges the three sinks):
//     background.js:4 -> fail   => a direct finding (also the cleartext finding)
//     background.js:7 -> unsure => diverted to the data-exfiltration-recheck consumer
//     background.js:8 -> unsure => diverted too
//   reviewAddon (the whole-add-on summary re-judges the diverted / handed items):
//     data-exfiltration-recheck  background.js:7 -> pass => dropped (benign)
//     data-exfiltration-recheck  background.js:8 -> fail => a finding
//     missing-english-localization-recheck -> unsure => back to manual review

// One verdict per data-exfiltration candidate, keyed by file:line.
export const verdicts = (ref) =>
  ref.file === "background.js" && ref.line === 4
    ? { verdict: "fail", reason: "posts collected data to a hardcoded endpoint" }
    : "unsure";

// The whole-add-on summary: fixed prose plus the recheck verdicts. The fake derives one
// recheck entry per item each consumer was handed (parsed from the prompt), so we only
// state the verdict, not the brittle item keys.
export const review = {
  summary: "Outbound Data Demo sends POST requests to three hardcoded hosts.",
  recheckVerdicts: {
    "data-exfiltration-recheck": {
      "background.js:7": "pass", // benign -> dropped
      "background.js:8": "fail", // confirmed exfiltration -> a finding
    },
    "missing-english-localization-recheck": "unsure", // stays manual
  },
};
