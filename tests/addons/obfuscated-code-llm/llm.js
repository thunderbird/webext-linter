// LLM answers for the obfuscated-code-llm fixture (see tests/fake-llm.js). Its presence
// turns --llm-review on for this fixture and drives the model paths deterministically.
//
// All three background scripts are revealing-module files that match ONLY the WEAK
// function_to_array_replacements structure (see src/lib/obfuscation.js), so none is a
// deterministic obfuscated-code finding: each becomes one LLM candidate, judged from
// its own file with no hint of what the detector matched. This exercises the full
// verdict mapping of the obfuscated-code LLM step:
//
//   module-fail.js   -> fail   => an obfuscated-code finding
//   module-pass.js   -> pass   => dropped (readable code)
//   module-unsure.js -> unsure => manual review (the instructions text)

// One verdict per obfuscated-code candidate, keyed by file (the candidates carry no
// line - the whole file is the subject).
export const verdicts = (ref) =>
  ref.file === "module-fail.js"
    ? { verdict: "fail", reason: "string table resolved through decoder indirection" }
    : ref.file === "module-pass.js"
      ? { verdict: "pass", reason: "ordinary readable module pattern" }
      : "unsure";

// The whole-add-on summary (--llm-review always runs it): fixed prose, no recheck
// items are handed over in this fixture.
export const review = {
  summary:
    "Weak Obfuscation Signal Demo ships three module-pattern background scripts.",
};
