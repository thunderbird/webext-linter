// Unit tests for the report-assembly resolver: filling registry text (keyed by
// ruleId) into finding messages and manual-review items. The registry is the
// only source of this text.

import { test } from "node:test";
import { REVIEW_MODE } from "../../src/lib/enum.js";
import assert from "node:assert/strict";

import {
  renderFindings,
  renderManualItems,
} from "../../src/report/responses.js";
import { loadRegistry, Registry } from "../../src/checks/registry.js";
import { artifactLabel } from "../../src/report/artifact.js";

const registry = loadRegistry();

// {{item}} is replaced with the finding's item, keyed by ruleId; horizontal
// whitespace is collapsed and the placeholder is gone. Most responses name no
// subject (it rides the locus instead), so this uses one that does.
test("renderFindings fills {{item}} from the registry response by ruleId", () => {
  const f = {
    ruleId: "missing-vendor-file",
    item: "VENDORS.md",
    message: null,
  };
  renderFindings([f], registry);
  assert.match(f.message, /listed in "VENDORS.md"/); // filled in the prose
  assert.ok(!f.message.includes("{{item}}"));
  assert.equal(f.message.split("\n").length, 1); // no 80-col wrapping survives
});

// A deliberate line break in the authored response survives: Issues prints a
// response verbatim, so the break before "Read more:" is the message's own.
test("renderFindings keeps an authored line break in the response", () => {
  const f = {
    ruleId: "deprecated-api",
    item: "messages.oldOne",
    message: null,
  };
  renderFindings([f], registry);
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

// Slots are filled in ONE pass from a fixed snapshot, so a submission-derived value
// that itself contains another slot's "{{placeholder}}" is emitted literally, never
// replaced by that slot's value. undeclared-build-source carries two such slots in one
// item (unresolvedBuildSteps + buildInstructions), which exposes this: a stray
// {{buildInstructions}} inside the unresolved steps must NOT splice in the real ones.
test("renderManualItems does not cross-splice one slot's value into another", () => {
  const items = renderManualItems(
    [
      {
        ruleId: "undeclared-build-source",
        item: null,
        manualReview: true,
        data: {
          unresolvedBuildSteps:
            "a step mentions {{buildInstructions}} verbatim",
          buildInstructions: "npm ci && npm run build",
        },
      },
    ],
    registry
  );
  assert.match(
    items[0].instructions,
    /mentions \{\{buildInstructions\}\} verbatim/
  );
  assert.doesNotMatch(items[0].instructions, /mentions npm ci/);

  // A slot value containing "$&"/"$1" (String.replace special patterns) renders
  // literally - fill() uses a function replacer, not a string replacement.
  const dollar = renderManualItems(
    [
      {
        ruleId: "undeclared-build-source",
        item: null,
        manualReview: true,
        data: {
          unresolvedBuildSteps: "cost is $& and $1 and $$",
          buildInstructions: "",
        },
      },
    ],
    registry
  );
  assert.match(dollar[0].instructions, /cost is \$& and \$1 and \$\$/);
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
  const consumed = { ruleId: "missing-vendor-file", item: "VENDORS.md" };
  const listed = { ruleId: "unrecognized-manifest-key", item: "fooBar" };
  renderFindings([consumed, listed], registry);
  assert.equal(consumed.listItem, false); // {{item}} is in the message
  assert.equal(listed.listItem, true); // generic message -> list it
});

// Registry prose is hard-wrapped in the yaml and re-collapsed for display
// (manualBody), so a phrase can straddle a source line break. Assertions about
// wording go through this rather than pinning where the wrap happens to fall.
const flat = (t) => String(t).replace(/\s+/g, " ");

// A manual-review escalation ref resolves to the owning entry's title +
// instructions, carrying its locus (file/loc) for the report to list rather
// than baking the identifier into the prose.
test("renderManualItems resolves an escalation to title + instructions + locus", () => {
  const [item] = renderManualItems(
    [{ ruleId: "unused-files", file: "stray.js", kind: "escalation" }],
    registry
  );
  assert.match(item.title, /Unused/);
  assert.match(
    flat(item.instructions),
    /reachable from no manifest entry point/
  );
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

// A substituted value is submission-derived - an item, a path, a URL, the developer's
// words - so fill() cleans each one. That is what keeps the finished `message` safe
// without stripping the message itself, whose authored line breaks must survive.
test("a substituted value carries no control characters into the message", () => {
  const ESC = "\u001B";
  const f = {
    ruleId: "missing-vendor-file",
    item: `VENDORS${ESC}[2K.md`,
    message: null,
  };
  renderFindings([f], registry);
  assert.ok(
    !f.message.includes(ESC),
    "the escape did not survive substitution"
  );
  assert.match(f.message, /VENDORS \[2K\.md/); // separated, not fused
});

// The same for a named {{slot}}: vendor-modified takes the declared source URL, which
// comes straight from the submission.
test("a named slot value carries no control characters", () => {
  const ESC = "\u001B";
  const f = {
    ruleId: "vendor-modified",
    item: "lib/a.min.js",
    data: { url: `https://x/${ESC}[1Aa.js` },
    message: null,
  };
  renderFindings([f], registry);
  assert.ok(!f.message.includes(ESC));
  // Replaced with a space, not deleted: deleting would let "htt<ESC>ps://evil" fuse
  // into a working URL, so the pieces stay visibly apart.
  assert.match(f.message, /https:\/\/x\/ \[1Aa\.js/);
});

// ---- manual-review items ----
// A manual-review item is one reading the code cannot settle, so it takes the entry's
// `manual-review-instructions` - a different question from the ordinary escalation's.
// It still carries the suggested response: once the reviewer settles the case against
// the add-on, that is the text the developer receives.
test("renderManualItems renders a manual-review item from its own wording", () => {
  const [item] = renderManualItems(
    [
      {
        ruleId: "remote-resources",
        item: "css https://fonts.example/f.css",
        hint: "https://cdn.example/lib@1.0.0/lib.css",
        file: "lib/lib.css",
        loc: { line: 1 },
        manualReview: true,
      },
    ],
    registry
  );
  // The reviewer is asked to decide, not to establish what the check established.
  assert.match(item.instructions, /matches a published/);
  assert.ok(!flat(item.instructions).includes("Confirm by hand"));
  assert.match(item.response, /Remote sources are not allowed/);
  // Item-free wording, so the site and its upstream are listed per locus.
  assert.equal(item.listItem, true);
  assert.equal(item.hint, "https://cdn.example/lib@1.0.0/lib.css");
});

// The same ref without the flag is the ordinary escalation, unchanged - which is what
// makes the assertions above about the flag rather than about this entry.
test("renderManualItems renders the same ref without the flag as before", () => {
  const [item] = renderManualItems(
    [{ ruleId: "remote-resources", item: "x" }],
    registry
  );
  assert.match(flat(item.instructions), /Confirm by hand/);
  assert.match(item.response, /Remote sources are not allowed/);
});

// Nothing at load time can tell which checks raise manual-review items, so an entry that
// raises one without authoring the wording must fail loudly here - the alternatives
// are a report that misdescribes the case or one that asks for a judgement with no
// grounds. unsafe-html authors no `manual-review-instructions`.
test("renderManualItems refuses a manual-review item with no authored wording", () => {
  assert.throws(
    () =>
      renderManualItems(
        [
          {
            ruleId: "unsafe-html",
            item: "x",
            manualReview: true,
            kind: "escalation",
          },
        ],
        registry
      ),
    /manual-review-instructions/
  );
});

// The wording choice is the registry's, so the raise belongs to the registry too -
// responses.js resolves templates and does not police who authored what.
test("registry.instructionsFor picks the wording and refuses an unauthored one", () => {
  assert.match(
    flat(registry.instructionsFor("remote-resources", true)),
    /matches a published/
  );
  assert.match(
    flat(registry.instructionsFor("remote-resources", false)),
    /Confirm by hand/
  );
  assert.throws(
    () => registry.instructionsFor("unsafe-html", true),
    /manual-review-instructions/
  );
});
