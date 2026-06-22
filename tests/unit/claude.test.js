// Unit tests for the provider-agnostic LLM result coercion (no network).

import { test } from "node:test";
import assert from "node:assert/strict";

import { coerceResult, coerceReview } from "../../src/llm/schema.js";
import { DEFAULT_MODEL_CLAUDE } from "../../src/config.js";

// Well-formed input passes through unchanged; empty/null input yields no
// verdicts (so the orchestrator defaults every candidate to "unsure", deferring
// to a human rather than a silent pass). Messy input is coerced: an unknown
// verdict to "unsure", entries without a string id dropped, a bad reason to null.
test("coerceResult normalizes the tool_use input", () => {
  assert.deepEqual(
    coerceResult({ verdicts: [{ id: "E1", verdict: "fail", reason: "r" }] }),
    { verdicts: [{ id: "E1", verdict: "fail", reason: "r" }] }
  );
  assert.deepEqual(coerceResult({}), { verdicts: [] });
  assert.deepEqual(coerceResult(null), { verdicts: [] });

  const messy = coerceResult({
    verdicts: [
      { id: "E1", verdict: "yes", reason: 5 }, // unknown verdict, bad reason
      { verdict: "pass" }, // no id -> dropped
      { id: "E2", verdict: "pass" },
    ],
  });
  assert.deepEqual(messy.verdicts, [
    { id: "E1", verdict: "unsure", reason: null },
    { id: "E2", verdict: "pass", reason: null },
  ]);
});

// Hostile shapes the model could plausibly return must never throw and never
// produce a spurious verdict: a non-array verdicts field, a non-object input
// (string/number/array/boolean), and entries whose id/verdict/reason have the
// wrong types all degrade to safe defaults (a missing-string id is dropped).
test("coerceResult survives hostile shapes", () => {
  assert.deepEqual(coerceResult({ verdicts: "oops" }).verdicts, []);

  for (const bad of ["x", 5, [], true]) {
    assert.deepEqual(coerceResult(bad), { verdicts: [] });
  }

  const r = coerceResult({
    verdicts: [
      { id: 5, verdict: "fail" }, // non-string id -> dropped
      { id: "ok", verdict: "fail", reason: {} }, // bad reason -> null
    ],
  });
  assert.deepEqual(r.verdicts, [{ id: "ok", verdict: "fail", reason: null }]);
});

// Well-formed --full-summary review input passes through; the summary defaults
// to "" when absent, and each recheck entry keeps its check + item, coerces an
// unknown verdict to the safe "unsure", and defaults a missing reason to "". An
// entry missing a check or item string is dropped.
test("coerceReview normalizes the report_addon_review input", () => {
  assert.deepEqual(
    coerceReview({
      summary: "S",
      recheck: [
        {
          check: "unused-permission",
          item: "tabs",
          verdict: "fail",
          reason: "r",
        },
      ],
    }),
    {
      summary: "S",
      recheck: [
        {
          check: "unused-permission",
          item: "tabs",
          verdict: "fail",
          reason: "r",
        },
      ],
    }
  );

  const messy = coerceReview({
    recheck: [
      { check: "c", item: "tabs", verdict: "maybe" }, // unknown verdict -> unsure
      { check: "c", item: "downloads", verdict: "pass", reason: 5 }, // bad reason -> ""
      { check: "c", verdict: "fail" }, // no item -> dropped
      { item: "x", verdict: "fail" }, // no check -> dropped
    ],
  });
  assert.equal(messy.summary, ""); // missing summary -> ""
  assert.deepEqual(messy.recheck, [
    { check: "c", item: "tabs", verdict: "unsure", reason: "" },
    { check: "c", item: "downloads", verdict: "pass", reason: "" },
  ]);
});

// Hostile shapes never throw and never invent an entry: a non-array recheck, a
// non-object input, and entries whose check/item has the wrong type all degrade
// to safe defaults.
test("coerceReview survives hostile shapes", () => {
  assert.deepEqual(coerceReview({ recheck: "oops" }), {
    summary: "",
    recheck: [],
  });
  for (const bad of ["x", 5, [], true, null]) {
    assert.deepEqual(coerceReview(bad), { summary: "", recheck: [] });
  }
  const r = coerceReview({
    summary: 7, // non-string -> ""
    recheck: [{ check: 5, item: "tabs", verdict: "fail" }], // non-string check
  });
  assert.deepEqual(r, { summary: "", recheck: [] });
});

// Pins the default model to the Sonnet tier so the client does not silently
// default to a different (e.g. more expensive) model family.
test("DEFAULT_MODEL_CLAUDE is a sonnet model", () => {
  assert.match(DEFAULT_MODEL_CLAUDE, /sonnet/);
});
