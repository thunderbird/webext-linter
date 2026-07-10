// Unit tests for the domain-facts loader (src/parse/webext-facts.js): it parses
// assets/webext-facts.yaml and exposes the hand-curated Thunderbird lists in the
// shapes their consumers use (Set / Map). Spot-checks, not exhaustive - the
// values' correctness is exercised by the checks that consume them.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  API_ROOTS,
  DATA_APIS,
  CORE_SYMBOLS,
  ROOT_RELATIVE_FILE_METHODS,
  BRIDGE,
} from "../../src/parse/webext-facts.js";

test("the Set facts load with the expected type and members", () => {
  for (const s of [
    API_ROOTS,
    DATA_APIS,
    CORE_SYMBOLS,
    ROOT_RELATIVE_FILE_METHODS,
  ]) {
    assert.ok(s instanceof Set && s.size > 0);
  }
  assert.deepEqual([...API_ROOTS], ["browser", "messenger", "chrome"]);
  assert.ok(DATA_APIS.has("messages") && DATA_APIS.has("compose"));
  assert.ok(CORE_SYMBOLS.has("Services") && CORE_SYMBOLS.has("ChromeUtils"));
  assert.ok(
    ROOT_RELATIVE_FILE_METHODS.has("runtime.getURL") &&
      ROOT_RELATIVE_FILE_METHODS.has("scripting.executeScript")
  );
});

test("BRIDGE loads as a Map keyed on the dotted method, specs intact", () => {
  assert.ok(BRIDGE instanceof Map && BRIDGE.size > 0);
  assert.deepEqual(BRIDGE.get("runtime.getURL"), { arg0: true });
  // Version-restricted MV2 entry keeps its mv tag and key spec.
  assert.deepEqual(BRIDGE.get("tabs.executeScript"), {
    stringKeys: ["file"],
    arrayKeys: ["files"],
    mv: 2,
  });
  assert.deepEqual(BRIDGE.get("action.setPopup"), {
    stringKeys: ["popup"],
    mv: 3,
  });
});
