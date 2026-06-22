// A run-scoped ceiling on the number of model requests, so one run cannot fan
// out into thousands of calls (see MAX_LLM_REQUESTS_PER_RUN in src/config.js).
// Every request site - the LLM checks' candidate batches, the advisory
// summaries, and the vendor-parse fallback - calls consume() before its model
// call and skips when it returns false; the remaining work then escalates to
// manual review, the same path a token-less run takes. One budget per run,
// shared across those sites (created in src/pipeline.js runPipeline).

import { progress } from "../util/log.js";

/**
 * @typedef {object} LlmBudget
 * @property {() => Promise<boolean>} consume  Reserve one request: true to
 *   proceed, false once the cap is reached and not extended (after which every
 *   further consume() is false, so the run makes no more model calls).
 */

/**
 * @param {object} opts
 * @param {number} opts.step  The initial cap AND the per-confirmation increment.
 * @param {(used: number) => boolean | Promise<boolean>} [opts.confirmMore]
 *   Asked when the cap is reached: a truthy answer grants `step` more requests
 *   (and is re-asked at the next multiple), a falsy answer stops. Omitted (a
 *   non-interactive run) means stop at the cap with no prompt.
 * @returns {LlmBudget}
 */
export function createLlmBudget({ step, confirmMore }) {
  let used = 0;
  let limit = step;
  let stopped = false;
  return {
    async consume() {
      if (stopped) {
        return false;
      }
      if (used >= limit) {
        const more = confirmMore ? await confirmMore(used) : false;
        if (!more) {
          stopped = true;
          progress(
            `  LLM request cap reached (${used}); ` +
              "remaining checks escalate to manual review."
          );
          return false;
        }
        limit += step;
      }
      used += 1;
      return true;
    },
  };
}
