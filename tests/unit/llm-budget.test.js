// Unit tests for the run-wide LLM request budget (createLlmBudget): it grants a
// fixed number of requests, then (interactively) asks whether to grant more,
// re-asking at every multiple, and stops for good on a falsy answer.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createLlmBudget } from "../../src/llm/budget.js";

// Without a confirmMore (a non-interactive run) the budget hard-stops at the cap.
test("budget grants `step` requests, then hard-stops without a prompt", async () => {
  const b = createLlmBudget({ step: 2 });
  assert.equal(await b.consume(), true);
  assert.equal(await b.consume(), true);
  assert.equal(await b.consume(), false); // cap reached, no one to ask -> stop
  assert.equal(await b.consume(), false); // stays stopped
});

// At the cap it asks; a truthy answer grants `step` more and it re-asks at the
// next multiple, so a runaway can never pass a checkpoint without confirmation.
test("budget asks at each multiple and grants `step` more on yes", async () => {
  const asked = [];
  // Yes the first time (used=2), no the second (used=4).
  const confirmMore = (used) => {
    asked.push(used);
    return asked.length === 1;
  };
  const b = createLlmBudget({ step: 2, confirmMore });
  const got = [];
  for (let i = 0; i < 5; i++) {
    got.push(await b.consume());
  }
  assert.deepEqual(got, [true, true, true, true, false]);
  assert.deepEqual(asked, [2, 4]); // asked at the first cap and again after +2
});

// A falsy answer stops for good - no further prompts after the first refusal.
test("budget stops permanently on a falsy answer (no re-asking)", async () => {
  let calls = 0;
  const b = createLlmBudget({
    step: 1,
    confirmMore: () => {
      calls++;
      return false;
    },
  });
  assert.equal(await b.consume(), true); // first request is free
  assert.equal(await b.consume(), false); // cap -> ask -> no
  assert.equal(await b.consume(), false); // already stopped, not asked again
  assert.equal(calls, 1);
});
