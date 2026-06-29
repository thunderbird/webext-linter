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

// {{item}} is replaced with the finding's item, keyed by ruleId; horizontal
// whitespace is collapsed and the placeholder is gone, but the deliberate line
// break before "Read more:" is preserved (Issues prints responses verbatim).
test("renderFindings fills {{item}} from the registry response by ruleId", () => {
  const f = {
    ruleId: "unsafe-html",
    item: "innerHTML",
    message: null,
  };
  renderFindings([f], registry);
  assert.match(f.message, /via "innerHTML"/); // {{item}} filled in the prose
  assert.ok(!f.message.includes("{{item}}"));
  // The only line break is the one before "Read more:" - the prose itself is
  // one line (no 80-col wrapping survives into the message).
  assert.match(f.message, /\nRead more:/);
  assert.equal(f.message.split("\n").length, 2);
});

// A response with no {{item}} is used wholesale (the item is irrelevant).
test("renderFindings uses a static response wholesale", () => {
  const f = { ruleId: "sync-xhr", item: null, message: null };
  renderFindings([f], registry);
  assert.match(f.message, /synchronous XMLHttpRequest/);
  assert.ok(!f.message.includes("\n"));
});

// find-lib-on-cdn names the ACTUAL identified library via {{item}} (no static
// example): the prose consumes {{item}}, so the file + jsDelivr source URL (the
// hint) surface on the per-finding location line - the real entry data, not a
// fabricated app/fuse.min.js example.
test("renderFindings fills the real library into find-lib-on-cdn (no example)", () => {
  const f = {
    ruleId: "find-lib-on-cdn",
    item: "fuse.js 7.0.0",
    hint: "https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.min.js",
    message: null,
  };
  renderFindings([f], registry);
  assert.match(f.message, /"fuse\.js 7\.0\.0"/); // the real lib, not an example
  assert.ok(!f.message.includes("{{item}}"));
  assert.ok(!f.message.includes("app/fuse.min.js")); // no hardcoded example path
  // {{item}} was consumed by the prose, so the subject is not re-listed on the
  // locus line; the hint (source URL) still is.
  assert.equal(f.listItem, false);
});

// An orchestrator system finding (ruleId "check-failed") renders from the
// registry `messages` map, with the check id filled in.
test("renderFindings renders a system message for check-failed", () => {
  const f = { ruleId: "check-failed", item: "unknown-api", message: null };
  renderFindings([f], registry);
  assert.match(f.message, /could not be run/);
  assert.match(f.message, /unknown-api/);
});

// listItem: when the response uses {{item}} the identifier is in the prose, so
// it is not also listed (false); when the response is item-free the identifier
// is surfaced on the finding's location line instead (true).
test("renderFindings sets listItem only for item-free responses", () => {
  const consumed = { ruleId: "missing-permission", item: "accountsRead" };
  const listed = { ruleId: "unrecognized-manifest-key", item: "fooBar" };
  renderFindings([consumed, listed], registry);
  assert.equal(consumed.listItem, false); // {{item}} is in the message
  assert.equal(listed.listItem, true); // generic message -> list it
});

// A manual-review escalation ref resolves to the owning entry's title +
// instructions, carrying its locus (file/loc) for the report to list rather
// than baking the identifier into the prose.
test("renderManualItems resolves an escalation to title + instructions + locus", () => {
  const [item] = renderManualItems(
    [{ ruleId: "unused-files", file: "stray.js", kind: "escalation" }],
    registry
  );
  assert.match(item.title, /Unused/);
  assert.match(item.instructions, /not reachable/);
  assert.equal(item.file, "stray.js"); // listed by the report, not in the prose
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

// A manual ref whose instructions are item-free (e.g. unused-permission-manual)
// carries listItem=true + its locus, so the report lists "file:line - item".
test("renderManualItems sets listItem + locus for an item-free instructions ref", () => {
  const [m] = renderManualItems(
    [
      {
        ruleId: "unused-permission-manual",
        item: "tabs",
        file: "manifest.json",
        loc: { line: 3 },
        kind: "escalation",
      },
    ],
    registry
  );
  assert.equal(m.listItem, true);
  assert.equal(m.item, "tabs");
  assert.equal(m.file, "manifest.json");
  assert.ok(!m.instructions.includes("{{item}}"));
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
