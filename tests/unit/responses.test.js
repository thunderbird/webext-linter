// Unit tests for the report-assembly resolver: filling registry text (keyed by
// ruleId) into finding messages and manual-review items. The registry is the
// only source of this text.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderFindings,
  renderManualItems,
} from "../../src/report/responses.js";
import { loadRegistry, Registry } from "../../src/checks/registry.js";
import { artifactLabel } from "../../src/report/artifact.js";

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

// find-lib-on-cdn uses the shared "recognized but undeclared" template (item-free,
// like missing-library): no static example path, and because the prose does not
// consume {{item}}, the real library name (item) and its jsDelivr source URL (the
// hint) surface on the per-finding location line instead.
test("renderFindings uses the generic find-lib-on-cdn template (real library listed)", () => {
  const f = {
    ruleId: "find-lib-on-cdn",
    item: "fuse.js 7.0.0",
    hint: "https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.min.js",
    message: null,
  };
  renderFindings([f], registry);
  assert.match(f.message, /recognized as third-party libraries/);
  assert.ok(!f.message.includes("{{item}}"));
  assert.ok(!f.message.includes("app/fuse.min.js")); // no hardcoded example path
  // The template is item-free, so the identifier (and its hint URL) is surfaced on
  // the finding's location line rather than in the prose.
  assert.equal(f.listItem, true);
});

// Slots are filled in ONE pass from a fixed snapshot, so a model-supplied value that
// itself contains another slot's "{{placeholder}}" is emitted literally, never
// replaced by that slot's value. undeclared-build-source is the first check with two
// model-controlled slots (explanation + buildInstructions) in one item, which exposes
// this: a stray {{buildInstructions}} inside the explanation must NOT splice in the
// real build steps.
test("renderManualItems does not cross-splice one model slot's value into another", () => {
  const items = renderManualItems(
    [
      {
        ruleId: "undeclared-build-source",
        item: null,
        kind: "escalation",
        data: {
          explanation: "the reason mentions {{buildInstructions}} verbatim",
          buildInstructions: "npm ci && npm run build",
        },
      },
    ],
    registry
  );
  assert.match(
    items[0].response,
    /mentions \{\{buildInstructions\}\} verbatim/
  );
  assert.doesNotMatch(items[0].response, /mentions npm ci/);

  // A slot value containing "$&"/"$1" (String.replace special patterns) renders
  // literally - fill() uses a function replacer, not a string replacement.
  const dollar = renderManualItems(
    [
      {
        ruleId: "undeclared-build-source",
        item: null,
        kind: "escalation",
        data: {
          explanation: "cost is $& and $1 and $$",
          buildInstructions: "",
        },
      },
    ],
    registry
  );
  assert.match(dollar[0].response, /cost is \$& and \$1 and \$\$/);
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

// The report labels a manual item's file:line by artifact ([XPI]/[SCA]) via
// ruleInputs.get(ruleId), so renderManualItems must carry ruleId through. Without it a
// non-manifest manual item has no ruleId and defaults to [SCA] (the unused-files mislabel).
test("renderManualItems carries the ruleId through for the artifact label", () => {
  const [item] = renderManualItems(
    [{ ruleId: "unused-files", file: "assets/x.png", kind: "escalation" }],
    registry
  );
  assert.equal(item.ruleId, "unused-files");
});

// End-to-end: a recheck consumer's manual item flows renderManualItems (ruleId) ->
// checkInputs/labelInputFor (its producer's corpus) -> artifactLabel. unused-files-recheck's
// producer (unused-files) is input: xpi, so its item must render [XPI], not [SCA] - the bug
// this change fixed. (Its OWN kind is post-summary-recheck with no input; the label follows
// the producer, proving the report never falls back to the consumer's absent input.)
test("a recheck consumer's XPI-corpus manual item labels [XPI] end-to-end", () => {
  const [item] = renderManualItems(
    [
      {
        ruleId: "unused-files-recheck",
        file: "assets/x.png",
        kind: "escalation",
      },
    ],
    registry
  );
  const label = artifactLabel({
    file: item.file,
    input: registry.checkInputs().get(item.ruleId),
    mode: "sca",
  });
  assert.equal(label, "XPI");
});

// A manual-review escalation can carry extra `data` slots, filled into the
// instructions alongside {{item}} - the mechanism any entry with a data-keyed
// placeholder rides on.
test("renderManualItems fills a data slot from the ref's data", () => {
  const reg = new Registry({
    "deterministic-phase": [
      {
        title: "Data slot",
        check: "data-slot",
        instructions:
          'The "{{item}}" case needs review. {{reason}} Decide by hand.',
      },
    ],
  });
  const [item] = renderManualItems(
    [
      {
        ruleId: "data-slot",
        item: "tabs",
        kind: "escalation",
        data: { reason: "no tab property is read" },
      },
    ],
    reg
  );
  assert.match(item.instructions, /"tabs"/);
  assert.match(item.instructions, /no tab property is read/);
  assert.ok(!item.instructions.includes("{{reason}}"));
});

// The unused-permission-recheck recheck consumer deliberately renders item-free and
// reason-free on BOTH verdict paths, so its entries collapse like the producer's
// manual reminder: fail findings share one identical message (groupByMessage
// merges them into a single numbered entry) and the permissions surface on the
// locus lines via listItem; the model's reason never reaches the report body.
test("unused-permission-recheck findings share one reason-free message and collapse", () => {
  const findings = [
    {
      ruleId: "unused-permission-recheck",
      item: "compose",
      file: "manifest.json",
      loc: { line: 17 },
      message: null,
      data: { reason: "no compose-tab injection found" },
    },
    {
      ruleId: "unused-permission-recheck",
      item: "tabs",
      file: "manifest.json",
      loc: { line: 25 },
      message: null,
      data: { reason: "no privileged tab reads found" },
    },
  ];
  renderFindings(findings, registry);
  assert.equal(findings[0].message, findings[1].message); // one group in the report
  assert.equal(findings[0].listItem, true); // permission on the locus line
  // LLM-confirmed: the finding states the verdict plainly, no "appears" hedging
  // (the hedged wording belongs to the unsure/manual paths).
  assert.match(findings[0].message, /permissions are unused/);
  assert.ok(!findings[0].message.includes("compose-tab injection"));
  assert.ok(!findings[0].message.includes("{{"));
});

test("an unsure unused-permission-recheck ref renders reason-free and item-listed", () => {
  const [m] = renderManualItems(
    [
      {
        ruleId: "unused-permission-recheck",
        item: "tabs",
        file: "manifest.json",
        loc: { line: 25 },
        kind: "escalation",
        data: { reason: "no privileged tab reads found" },
      },
    ],
    registry
  );
  assert.equal(m.listItem, true);
  assert.equal(m.item, "tabs");
  assert.ok(!m.instructions.includes("no privileged tab reads found"));
  assert.ok(!m.instructions.includes("{{"));
});

// A manual ref whose instructions are item-free (e.g. unused-permission)
// carries listItem=true + its locus, so the report lists "file:line - item".
test("renderManualItems sets listItem + locus for an item-free instructions ref", () => {
  const [m] = renderManualItems(
    [
      {
        ruleId: "unused-permission",
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
