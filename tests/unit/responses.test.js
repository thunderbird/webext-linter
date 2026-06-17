// Unit tests for the report-assembly resolver: filling registry text (keyed by
// ruleId) into finding messages and manual-review items. The registry is the
// only source of this text.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderFindings,
  renderManualItems,
} from "../../src/report/responses.js";
import { loadRegistry } from "../../src/checks/registry.js";

const registry = loadRegistry();

// {{item}} is replaced with the finding's item, keyed by ruleId; the result is
// a single line with no raw placeholder.
test("renderFindings fills {{item}} from the registry response by ruleId", () => {
  const f = {
    ruleId: "unknown-api",
    item: "browser.contextMenus",
    message: null,
  };
  renderFindings([f], registry);
  assert.match(f.message, /browser\.contextMenus/);
  assert.match(f.message, /is not supported/);
  assert.ok(!f.message.includes("\n"), "message should be a single line");
  assert.ok(!f.message.includes("{{item}}"));
});

// A response with no {{item}} is used wholesale (the item is irrelevant).
test("renderFindings uses a static response wholesale", () => {
  const f = { ruleId: "sync-xhr", item: null, message: null };
  renderFindings([f], registry);
  assert.match(f.message, /synchronous XMLHttpRequest/);
  assert.ok(!f.message.includes("\n"));
});

// An orchestrator system finding (ruleId "check-failed") renders from the
// registry `messages` map, with the check id filled in.
test("renderFindings renders a system message for check-failed", () => {
  const f = { ruleId: "check-failed", item: "unknown-api", message: null };
  renderFindings([f], registry);
  assert.match(f.message, /could not be run/);
  assert.match(f.message, /unknown-api/);
});

// A manual-review escalation ref resolves to the owning entry's title +
// instructions, with {{item}} filled.
test("renderManualItems resolves an escalation to title + instructions", () => {
  const [item] = renderManualItems(
    [{ ruleId: "unused-files", item: "stray.js", kind: "escalation" }],
    registry
  );
  assert.match(item.title, /Unused/);
  assert.match(item.instructions, /stray\.js/);
  assert.ok(!item.instructions.includes("{{item}}"));
});

// A manual-review escalation can carry extra `data` slots (e.g. a reason),
// filled into the instructions alongside {{item}} - used by the
// unused-permission check's "unsure" cases.
test("renderManualItems fills {{reason}} from the ref's data", () => {
  const [item] = renderManualItems(
    [
      {
        ruleId: "unused-permission",
        item: "tabs",
        kind: "escalation",
        data: { reason: "no tab property is read" },
      },
    ],
    registry
  );
  assert.match(item.title, /unused permission/i);
  assert.match(item.instructions, /"tabs"/);
  assert.match(item.instructions, /no tab property is read/);
  assert.ok(!item.instructions.includes("{{reason}}"));
});

// An llm-error ref uses the llm-unavailable system message (not the entry's
// instructions), still under the owning entry's title.
test("renderManualItems uses llm-unavailable for an llm-error ref", () => {
  const [item] = renderManualItems(
    [{ ruleId: "missing-english-localization", item: "x", kind: "llm-error" }],
    registry
  );
  assert.match(item.instructions, /could not be evaluated/i);
});
