// A fake add-on-review transport for createLlmClient's injectable `callReview`. It
// stands in for a provider adapter (src/llm/{anthropic,openai}.js): it records the
// assembled { system, prompt } it was handed and returns coerceReview() of a canned
// RAW model payload - the SAME coercion boundary the real adapters apply. So a test
// can drive the real assemble -> reviewAddon -> coerceReview path with a hostile raw
// response and then inspect exactly what prompt the model would have seen.

import { coerceReview } from "../../src/llm/schema.js";

/**
 * @param {object|((p: object) => object)} raw  The raw model payload (pre-coercion),
 *   or a function of the recorded call that returns one.
 * @returns {{callReview: (p: object) => Promise<object>, calls: object[]}}
 */
export function fakeReviewTransport(raw) {
  const calls = [];
  const callReview = async (p) => {
    calls.push(p);
    return coerceReview(typeof raw === "function" ? raw(p) : raw);
  };
  return { callReview, calls };
}
