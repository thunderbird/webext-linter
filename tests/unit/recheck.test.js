// The post-summary recheck mechanism (src/checks/lib/recheck.js + the runChecks
// divert): producers hand their manual items to a recheck consumer when the full
// summary runs, the summary re-judges them, and resolveRecheck maps each verdict
// back to a finding / drop / manual item. Covers the verdict mapping, the guard
// (only handed-over items can be touched), the summary-prompt composition, and the
// orchestrator divert itself.

import { withManifest } from "./manifest-ctx.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveRecheck,
  buildRecheckSections,
} from "../../src/checks/lib/recheck.js";
import {
  runChecks,
  loadChecks,
  loadRegistry,
  Registry,
} from "../../src/checks/registry.js";

// A handed-over manual item, as the producer's escalation became (manualRef).
const handed = (item, line) => ({
  ruleId: "producer",
  item,
  file: "manifest.json",
  loc: { line },
  kind: "escalation",
  data: null,
});

// ---- resolveRecheck: verdict -> finding / drop / manual ----
// fail -> a finding (carrying the model reason + locus), pass -> dropped, unsure
// -> a manual escalation, and an item with no verdict at all (summary skipped or
// errored) also -> manual. The consumer's own id/severity are stamped later by
// runOneCheck, so resolveRecheck leaves them null here.
test("resolveRecheck maps each verdict to a finding, a drop, or a manual item", () => {
  const ctx = {
    recheck: new Map([
      ["c", [handed("a", 4), handed("b", 5), handed("c", 6), handed("d", 7)]],
    ]),
    addon: {
      recheck: [
        { check: "c", item: "a", verdict: "fail", reason: "unused" },
        { check: "c", item: "b", verdict: "pass", reason: "used" },
        { check: "c", item: "c", verdict: "unsure", reason: "cannot tell" },
        // "d" gets no verdict at all.
      ],
    },
  };
  const out = resolveRecheck(withManifest(ctx), { id: "c" });

  assert.deepEqual(
    out.findings.map((f) => f.item),
    ["a"] // only the fail
  );
  assert.equal(out.findings[0].data.reason, "unused");
  assert.equal(out.findings[0].loc.line, 4); // locus carried from the handed item
  assert.equal(out.findings[0].file, "manifest.json");

  assert.deepEqual(
    out.escalations.map((e) => e.item).sort(),
    ["c", "d"] // unsure AND the missing verdict both fall to manual
  );
  const c = out.escalations.find((e) => e.item === "c");
  assert.equal(c.data.reason, "cannot tell");
  assert.equal(c.loc.line, 6);
});

// A recheck consumer runs on the main ctx (input: source) but its items belong to its
// producer's corpus. Its feed notes must be labelled by that corpus (check.labelInput),
// passed to ctx.note as the 5th arg - so an XPI-corpus recheck's notes read [XPI], not
// [SCA]. Covers the pass path (item "a") and the no-verdict -> unsure path (item "b").
test("resolveRecheck labels its feed notes by the consumer's labelInput", () => {
  const noteCalls = [];
  const ctx = {
    note: (...args) => noteCalls.push(args),
    recheck: new Map([["c", [handed("a", 4), handed("b", 5)]]]),
    addon: {
      recheck: [{ check: "c", item: "a", verdict: "pass", reason: "" }],
    },
  };
  resolveRecheck(withManifest(ctx), { id: "c", labelInput: "xpi" });
  assert.ok(noteCalls.length >= 2); // one per handed item
  for (const args of noteCalls) {
    assert.equal(args[4], "xpi", "every feed note carries the acts-on corpus");
  }
});

// When a consumer carries no labelInput, resolveRecheck passes undefined so makeNote
// falls back to its bound (run-ctx) input - the pre-existing behaviour is preserved.
test("resolveRecheck passes undefined labelInput when the check has none", () => {
  const noteCalls = [];
  const ctx = {
    note: (...args) => noteCalls.push(args),
    recheck: new Map([["c", [handed("a", 4)]]]),
    addon: {
      recheck: [{ check: "c", item: "a", verdict: "pass", reason: "" }],
    },
  };
  resolveRecheck(withManifest(ctx), { id: "c" });
  assert.equal(noteCalls[0][4], undefined);
});

// The guard: resolveRecheck only consults verdicts for items it was actually
// handed. A verdict for an item that was never handed over (a model invention),
// or one tagged for a different check, is inert - it can neither add nor flip a
// result.
test("resolveRecheck ignores verdicts for items it was not handed (the guard)", () => {
  const ctx = {
    recheck: new Map([["c", [handed("real", 4)]]]),
    addon: {
      recheck: [
        { check: "c", item: "real", verdict: "pass", reason: "" },
        { check: "c", item: "ghost", verdict: "fail", reason: "invented" },
        {
          check: "other",
          item: "real",
          verdict: "fail",
          reason: "wrong check",
        },
      ],
    },
  };
  const out = resolveRecheck(withManifest(ctx), { id: "c" });
  // "real" passed -> dropped; "ghost" and the other-check verdict are ignored.
  assert.deepEqual(out.findings, []);
  assert.deepEqual(out.escalations, []);
});

// With nothing handed to this consumer, it is a clean no-op (even if the summary
// happened to return verdicts tagged with its id).
test("resolveRecheck is a no-op when nothing was handed over", () => {
  assert.deepEqual(resolveRecheck({}, { id: "c" }), {
    findings: [],
    escalations: [],
  });
  assert.deepEqual(
    resolveRecheck(
      {
        recheck: new Map(),
        addon: { recheck: [{ check: "c", item: "x", verdict: "fail" }] },
      },
      { id: "c" }
    ),
    { findings: [], escalations: [] }
  );
});

// A per-site producer hands items with no `item` token but a `loc` (e.g.
// data-exfiltration's per-sink manual items). Those key on file:line, so two sinks
// in the same file get distinct verdicts instead of collapsing to one key. A
// per-locus `hint` (the transmission method) rides along but does NOT affect the key.
test("loc-bearing items with no item token key on file:line", () => {
  const sink = (line) => ({
    ruleId: "p",
    item: null,
    hint: "fetch()",
    file: "bg.js",
    loc: { line },
    kind: "escalation",
    data: null,
  });
  const ctx = {
    recheck: new Map([["x", [sink(4), sink(7)]]]),
    addon: {
      recheck: [
        { check: "x", item: "bg.js:4", verdict: "fail", reason: "a" },
        { check: "x", item: "bg.js:7", verdict: "pass", reason: "b" },
      ],
    },
  };
  // The two same-file sinks resolve independently: 4 -> finding, 7 -> dropped.
  const out = resolveRecheck(withManifest(ctx), { id: "x" });
  assert.deepEqual(
    out.findings.map((f) => f.loc.line),
    [4]
  );
  assert.equal(out.findings[0].hint, "fetch()"); // the method shows on the locus
  assert.deepEqual(out.escalations, []);
  // ...and they are listed in the wrapped item data as distinct file:line keys.
  const { items } = buildRecheckSections(
    { recheck: new Map([["x", [sink(4), sink(7)]]]) },
    { checkEntry: () => ({ "summary-prompt": "R" }) },
    "NONCE"
  );
  assert.ok(items.includes("- bg.js:4"));
  assert.ok(items.includes("- bg.js:7"));
});

// ---- buildRecheckSections: trusted rubric vs untrusted item data ----
// Per consumer with handed items: the trusted RUBRIC (summary-prompt + the uniform
// bullet instruction, labeled with the consumer's title) for the system prompt, and
// the de-duplicated item keys WRAPPED in nonce markers (tagged with the check id) for
// the untrusted user data. Both empty when nothing was handed over.
test("buildRecheckSections composes a labeled section per consumer", () => {
  const registry = {
    checkEntry: (id) => ({
      "summary-prompt": `RUBRIC for ${id}`,
      title: "Unused permission",
    }),
  };
  const ctx = {
    recheck: new Map([
      ["unused-permission-recheck", [handed("tabs", 4), handed("storage", 5)]],
    ]),
  };
  const { rubric, items } = buildRecheckSections(ctx, registry, "NONCE");
  assert.ok(rubric.includes("recheck: unused-permission-recheck"));
  assert.ok(rubric.includes("RUBRIC for unused-permission-recheck"));
  assert.ok(rubric.includes('check="unused-permission-recheck"'));
  // Item keys are in the wrapped, id-tagged user data, not the rubric.
  assert.ok(
    items.includes(
      '[[[BEGIN RECHECK-ITEMS NONCE id="unused-permission-recheck"]]]'
    )
  );
  assert.ok(items.includes("- tabs"));
  assert.ok(items.includes("- storage"));
  // The bullet instruction is in the rubric, labeled with the consumer's title.
  assert.ok(rubric.includes("add a separate bullet point"));
  assert.ok(rubric.includes('labeled "Unused permission"'));
});

// The SCA split runs one summary per corpus; each passes a `consumers` set so its prompt
// carries only the recheck consumers anchored to that corpus. Buckets outside the set are
// omitted (they ride the other corpus's summary).
test("buildRecheckSections restricts to the given consumers", () => {
  const registry = {
    checkEntry: (id) => ({ "summary-prompt": `RUBRIC for ${id}` }),
  };
  const ctx = {
    recheck: new Map([
      ["data-exfiltration-recheck", [handed("bg.js:4", 4)]],
      ["unused-files-recheck", [handed("lib/x.js", 1)]],
    ]),
  };
  const { rubric, items } = buildRecheckSections(
    ctx,
    registry,
    "NONCE",
    new Set(["data-exfiltration-recheck"])
  );
  assert.ok(rubric.includes("recheck: data-exfiltration-recheck"));
  assert.ok(items.includes("- bg.js:4"));
  // The XPI-anchored consumer is not in this (source) pass.
  assert.ok(!rubric.includes("unused-files-recheck"));
  assert.ok(!items.includes("lib/x.js"));
});

// The bullet label falls back to the check id when the consumer entry has no title.
test("buildRecheckSections labels the bullet with the id when no title", () => {
  const registry = {
    checkEntry: (id) => ({ "summary-prompt": `RUBRIC for ${id}` }),
  };
  const { rubric } = buildRecheckSections(
    { recheck: new Map([["x", [handed("a", 1)]]]) },
    registry,
    "NONCE"
  );
  assert.ok(rubric.includes("add a separate bullet point"));
  assert.ok(rubric.includes('labeled "x"'));
});

test("buildRecheckSections is empty when nothing was handed over", () => {
  const registry = { checkEntry: () => ({ "summary-prompt": "R" }) };
  assert.deepEqual(buildRecheckSections({}, registry, "N"), {
    rubric: "",
    items: "",
  });
  assert.deepEqual(
    buildRecheckSections({ recheck: new Map() }, registry, "N"),
    {
      rubric: "",
      items: "",
    }
  );
});

// A recheck target whose registry entry has no summary-prompt is skipped (its
// items still fall back to manual via resolveRecheck, so none are lost).
test("buildRecheckSections skips a consumer with no summary-prompt", () => {
  const registry = { checkEntry: () => ({}) };
  const ctx = { recheck: new Map([["x", [handed("a", 1)]]]) };
  assert.deepEqual(buildRecheckSections(ctx, registry, "N"), {
    rubric: "",
    items: "",
  });
});

// ---- the runChecks divert ----
// The unused-permission producer declares one manual item per unused permission
// it could not decide deterministically. When ctx.recheckActive, runChecks asks
// registry.rechecks(consumer, item) per item: a permission the registry has a
// rubric prompt for goes to ctx.recheck (the LLM re-judges it); one it has no
// prompt for (function-gated) stays manual. When inactive, all stay in manual
// review and ctx.recheck is never created. The jsSource keeps the tabs tokens
// PRESENT (a real tabs.query({url}) call), so tabs escalates rather than being
// decided deterministically - the divert is what these tests exercise.
const producerCtx = () => {
  const manifest = {
    manifest_version: 3,
    permissions: ["tabs", "storage"],
  };
  return {
    jsSources: [
      {
        file: "bg.js",
        code: 'browser.tabs.query({ url: "https://x/*" });',
        lineOffset: 0,
      },
    ],
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
      ]),
      // Pre-set so getPermissionAnalysis returns it (nothing provably used), no
      // schema needed: both declared permissions are escalated by the producer.
      permissionAnalysis: { usedPermissions: new Set() },
    },
  };
};

test("runChecks hands only permissions with a rubric prompt to the recheck; the rest stay manual", async () => {
  const registry = loadRegistry();
  const ctx = { ...producerCtx(), recheckActive: true };
  const out = await runChecks(withManifest(ctx), registry, {
    only: ["unused-permission"],
  });
  // "tabs" has a permission-prompt -> handed to the recheck consumer; "storage" has
  // none -> stays in manual review even though recheck is active.
  assert.deepEqual(
    out.manualItems.map((m) => m.item),
    ["storage"]
  );
  assert.deepEqual(
    ctx.recheck.get("unused-permission-recheck").map((m) => m.item),
    ["tabs"]
  );
});

test("runChecks leaves a producer's manual items in manual review when inactive", async () => {
  const registry = loadRegistry();
  const ctx = { ...producerCtx(), recheckActive: false };
  const out = await runChecks(withManifest(ctx), registry, {
    only: ["unused-permission"],
  });
  assert.deepEqual(out.manualItems.map((m) => m.item).sort(), [
    "storage",
    "tabs",
  ]);
  assert.equal(ctx.recheck, undefined); // nothing was diverted
});

// registry.rechecks is the divert's per-item gate: a permission-recheck consumer takes
// only permissions it has a prompt for; any other consumer takes every item.
test("registry.rechecks gates permission items by whether a prompt exists", () => {
  const registry = loadRegistry();
  assert.equal(
    registry.rechecks("unused-permission-recheck", { item: "tabs" }),
    true
  );
  assert.equal(
    registry.rechecks("unused-permission-recheck", { item: "storage" }),
    false
  );
  // unlimitedStorage now has a prompt (no longer hand-exempt) -> handed to the recheck.
  assert.equal(
    registry.rechecks("unused-permission-recheck", {
      item: "unlimitedStorage",
    }),
    true
  );
  // A consumer without `permission-recheck` (here the producer entry) takes all items.
  assert.equal(registry.rechecks("unused-permission", { item: "x" }), true);
});

// The registry is the single source of truth for which permissions the recheck can
// judge: every permission-prompts entry must name each of its `permissions` in its own
// `prompt`, or the model judges that permission with no grounding - the guessing this
// grounding exists to remove.
test("every permission-prompts entry grounds each of its permissions", () => {
  const entries = loadRegistry().permissionPrompts();
  assert.ok(entries.length > 0, "expected permission-prompts entries");
  for (const e of entries) {
    for (const perm of e.permissions) {
      assert.match(
        e.prompt,
        new RegExp(`\\b${perm}\\b`),
        `permission-prompts entry "${e.permissions.join(", ")}" must ground "${perm}"`
      );
    }
  }
});

// The script-injection entries make the runtime-gated injection permissions recheckable -
// a permission-prompts entry is the only thing that lets the LLM re-judge them (otherwise an
// injection-only add-on leaves them ungrounded -> straight to manual).
test("the injection permissions (activeTab, compose, messagesModify, scripting) are recheckable", () => {
  const recheckable = loadRegistry().recheckablePermissions();
  for (const p of ["activeTab", "compose", "messagesModify", "scripting"]) {
    assert.ok(recheckable.has(p), `expected "${p}" to be recheckable`);
  }
});

// The report/feed label is the corpus a check ACTS ON, not the ctx it runs on. A recheck
// consumer runs on the main ctx (input: source) but acts on its producer's corpus, so
// checkInputs (the report's ruleInputs) must report that corpus - else an XPI-corpus
// recheck mislabels its items [SCA]. Non-recheck checks keep their declared input.
test("checkInputs labels a recheck consumer by the corpus it acts on, not its input", () => {
  const reg = loadRegistry();
  const inputs = reg.checkInputs();
  const { xpi, source } = reg.recheckConsumersByCorpus();
  assert.ok(xpi.size > 0, "expected at least one XPI-corpus recheck consumer");
  for (const id of xpi) {
    assert.equal(inputs.get(id), "xpi", id);
  }
  for (const id of source) {
    assert.equal(inputs.get(id), "source", id);
  }
  // a non-recheck check keeps its declared input (unused-files producer is input: xpi)
  assert.equal(inputs.get("unused-files"), "xpi");
});

// The recheck consumers live in their own post-summary-rechecks section: tagged kind
// "post-summary-recheck", they declare NO input (they run on the main ctx and are
// labelled by their producer's corpus), and load with phase "post-summary".
test("post-summary-recheck consumers are section-tagged, input-free, and post-summary", async () => {
  const reg = loadRegistry();
  const { xpi, source } = reg.recheckConsumersByCorpus();
  const consumers = [...xpi, ...source];
  assert.ok(consumers.length >= 6, "expected the recheck consumers");
  for (const id of consumers) {
    assert.equal(reg.checkEntry(id)?.kind, "post-summary-recheck", id);
  }
  const loaded = await loadChecks(reg);
  for (const id of consumers) {
    const c = loaded.find((x) => x.id === id);
    assert.equal(c.input, undefined, `${id} input`);
    assert.equal(c.phase, "post-summary", `${id} phase`);
  }
});

// A post-summary-rechecks entry must NOT declare `input` (its corpus is derived from its
// producer); declaring one is a config error caught at load.
test("loadChecks rejects a post-summary-recheck that declares input", async () => {
  const reg = new Registry({
    "post-summary-rechecks": [
      {
        title: "X",
        check: "unused-permission-recheck",
        input: "source",
        "permission-recheck": true,
      },
    ],
  });
  await assert.rejects(loadChecks(reg), /must not declare/);
});

// A recheck rubric (summary-prompt / permission-recheck) and post-summary-rechecks section
// membership must be in lock-step: phase is derived from the section, so a rubric-bearing
// consumer left in another section would silently get no post-summary phase and never be
// re-judged. loadChecks rejects either half of the mismatch.
test("loadChecks requires a recheck rubric to live in (and only in) the post-summary-rechecks section", async () => {
  const stray = new Registry({
    "llm-checks": [
      {
        title: "S",
        check: "unused-files-recheck",
        input: "source",
        "summary-prompt": "x",
      },
    ],
  });
  await assert.rejects(
    loadChecks(stray),
    /not in the post-summary-rechecks section/
  );
  const bare = new Registry({
    "post-summary-rechecks": [{ title: "B", check: "unused-files-recheck" }],
  });
  await assert.rejects(loadChecks(bare), /carries no recheck rubric/);
});

// A recheck is judged by the source or packaging summary pass (the source / xpi corpora); a
// producer on any OTHER corpus (build, manifest) belongs to neither, so its diverted
// items would never be judged - loadChecks rejects it.
test("loadChecks rejects a non-source/xpi producer that declares a post-summary-recheck", async () => {
  const producer = (input) =>
    new Registry({
      "deterministic-checks": [
        {
          title: "P",
          check: "unused-files",
          input,
          "post-summary-recheck": "unused-files-recheck",
        },
      ],
      "post-summary-rechecks": [
        { title: "C", check: "unused-files-recheck", "summary-prompt": "x" },
      ],
    });
  await assert.rejects(loadChecks(producer("build")), /input: build/);
  await assert.rejects(loadChecks(producer("manifest")), /input: manifest/);
});

// A version bound written unquoted in YAML parses as a number; the loader must coerce
// it to a string so parseVersion accepts it (a bare number would void the bound and
// make both tabs variants match every version).
test("permissionPrompts coerces a numeric version bound to a string", () => {
  const reg = new Registry({
    "permission-prompts": [
      { permissions: "tabs", prompt: "tabs", min_strict_version: 154 },
    ],
  });
  assert.strictEqual(reg.permissionPrompts()[0].minStrictVersion, "154");
});

// The optional `tokens` list (the code-level spellings of a prompt's justifying
// usages) is surfaced per entry; an entry without tokens yields [] - the
// producer's "deterministically undecidable" marker (unlimitedStorage: quota/
// OPFS use is not token-detectable).
test("permissionPrompts surfaces the optional usage tokens", () => {
  const entries = loadRegistry().permissionPrompts();
  const compose = entries.find((e) => e.permissions.includes("compose"));
  assert.deepEqual(compose.tokens, [
    "compose_scripts",
    "executeScript",
    "insertCSS",
    "attachments",
  ]);
  const unlimited = entries.find((e) =>
    e.permissions.includes("unlimitedStorage")
  );
  assert.deepEqual(unlimited.tokens, []);
});

// A producer declaring a post-summary-recheck gets its consumer's data attached
// at load (check.recheck): the consumer's entry always, the permission-prompts
// list (tokens included) only for a permission-recheck consumer - the producer's
// source for deterministic verdicts. Consumers themselves carry none.
test("loadChecks attaches the linked consumer's data to a producer", async () => {
  const loaded = await loadChecks(loadRegistry());
  const producer = loaded.find((c) => c.id === "unused-permission");
  assert.equal(producer.postSummaryRecheck, "unused-permission-recheck");
  assert.ok(producer.recheckData.permissionPrompts.length > 0);
  // Deliberately narrow: the token entries only - no prompt prose, no consumer
  // entry - so a producer has no window into its consumer's wording.
  for (const e of producer.recheckData.permissionPrompts) {
    assert.ok(!("prompt" in e), "prompt text must be stripped");
    assert.ok(Array.isArray(e.tokens));
  }
  const files = loaded.find((c) => c.id === "unused-files");
  assert.equal(files.recheckData, undefined); // static-rubric consumer
  const consumer = loaded.find((c) => c.id === "unused-permission-recheck");
  assert.equal(consumer.recheckData, undefined);
});

// Token hygiene: a stray empty/null YAML item must not become the token "null"
// (String(null) is truthy), which would match almost any code and silently
// disable the entry's deterministic verdict.
test("permissionPrompts drops null/empty token items before stringifying", () => {
  const reg = new Registry({
    "permission-prompts": [
      { permissions: "tabs", prompt: "tabs", tokens: [null, "", "query", 42] },
    ],
  });
  assert.deepEqual(reg.permissionPrompts()[0].tokens, ["query", "42"]);
});

// Self-grounding guard: token matching (case-sensitive, word boundary) includes
// the manifest's own permissions array, so a token that matches a minimal
// manifest declaring ONLY the entry's own permissions would ground itself and
// render the entry silently inert.
test("no entry's token matches its own permission declaration", () => {
  for (const e of loadRegistry().permissionPrompts()) {
    const minimal = JSON.stringify({ permissions: e.permissions });
    for (const t of e.tokens) {
      assert.ok(
        !new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
          minimal
        ),
        `token "${t}" self-grounds on ${JSON.stringify(e.permissions)}`
      );
    }
  }
});

// ---- permission-recheck assembly (buildRecheckSections) ----
// A permission-recheck consumer assembles its rubric per review from the framing +
// the permission-prompts for exactly the permissions handed over, and picks the tabs
// variant by the add-on's strict_min_version (D308076).
const permRubric = (perms, strictMin) => {
  const manifest = strictMin
    ? {
        browser_specific_settings: { gecko: { strict_min_version: strictMin } },
      }
    : {};
  const ctx = {
    manifest,
    recheck: new Map([
      [
        "unused-permission-recheck",
        perms.map((p) => ({ item: p, file: "manifest.json" })),
      ],
    ]),
  };
  return buildRecheckSections(ctx, loadRegistry(), "NONCE").rubric;
};

test("assembly includes only the sections for the permissions handed over", () => {
  const rubric = permRubric(["cookies"], "154");
  assert.match(rubric, /\bcookies\b/);
  assert.doesNotMatch(rubric, /\baccountsRead\b/);
  assert.doesNotMatch(rubric, /Be careful with "tabs"/); // no tabs section pulled in
});

// The widened groundings reach the assembled rubric: accountsRead names its added
// gates (not just the original header folder), and the no-API unlimitedStorage is
// grounded on the add-on persisting data rather than hand-exempted.
test("assembly grounds accountsRead on its widened gates and unlimitedStorage on storage", () => {
  const acct = permRubric(["accountsRead"], "154");
  for (const gate of ["identityId", "folderId", "selectedFolders"]) {
    assert.match(acct, new RegExp(`\\b${gate}\\b`), gate);
  }
  const quota = permRubric(["unlimitedStorage"], "154");
  assert.match(quota, /\bunlimitedStorage\b/);
  assert.match(quota, /IndexedDB|storage\.local/); // grounded on persisting data
});

// webRequestBlocking is arg-gated: the "blocking" string sits INSIDE the extraInfoSpec
// array passed to a webRequest.on* addListener, not as a standalone argument. The prompt
// must say so, or the model reads ["blocking", ...] as absent (the thunderjira false positive).
test("assembly grounds webRequestBlocking on the blocking string inside an array argument", () => {
  const wrb = permRubric(["webRequestBlocking"], "154");
  assert.match(wrb, /\bwebRequestBlocking\b/);
  assert.match(wrb, /extraInfoSpec/);
  assert.match(wrb, /\barray\b/); // the array argument, not a standalone "blocking" arg
});

test("assembly selects the tabs variant by strict_min_version", () => {
  for (const min of ["154", "154.0", "200"]) {
    const post = permRubric(["tabs"], min);
    assert.match(post, /Since Thunderbird 154/, `min=${min}`); // fixed
    assert.doesNotMatch(
      post,
      /as justified whenever the code calls tabs.query/,
      `min=${min}`
    );
  }
  // Everything below 154 - including 153.x point releases, unset and unparsable -
  // gets the pre-D308076 wording (the [154, ) / ( , 154) variants must partition
  // the version line with no gap: a 153.9 add-on must not fall through to no rubric).
  for (const min of ["153.9", "153.5", "153", "128", undefined, "abc"]) {
    const pre = permRubric(["tabs"], min);
    assert.match(
      pre,
      /as justified whenever the code calls tabs.query/,
      `min=${String(min)}`
    );
    assert.doesNotMatch(pre, /Since Thunderbird 154/, `min=${min}`);
  }
});

// The version-bounded tabs variants must tile the version line: for EVERY
// strict_min_version, the tabs recheck gets exactly one grounding - never none (a
// gap sends tabs to the LLM ungrounded) and never both.
test("the tabs variants partition every strict_min_version (no gap, no overlap)", () => {
  const wordings = (min) => {
    const r = permRubric(["tabs"], min);
    return [
      /Since Thunderbird 154/.test(r), // post
      /as justified whenever the code calls tabs.query/.test(r), // pre
    ].filter(Boolean).length;
  };
  for (const min of [
    "154",
    "153.99",
    "153.9",
    "153.1",
    "153",
    "128",
    "60",
    "200",
    "115.2.1",
    undefined,
    "abc",
  ]) {
    assert.equal(
      wordings(min),
      1,
      `exactly one tabs variant for min=${String(min)}`
    );
  }
});

test("assembly yields no rubric for a permission with no prompt (it falls to manual)", () => {
  assert.equal(permRubric(["storage"], "154"), "");
});

// A recheck permission whose ONLY prompt is version-bounded is not grounded for an
// out-of-range add-on. It must be dropped from the items sent to the model (and fall
// to manual via resolveRecheck), never judged with no grounding: the items block must
// list only the permissions the assembled rubric actually grounds.
test("assembly drops a handed permission no version-matching prompt grounds", () => {
  const reg = new Registry({
    "deterministic-checks": [
      {
        title: "U",
        check: "unused-permission-recheck",
        "permission-recheck": true,
      },
    ],
    "permission-prompt-framing": { preamble: "PRE.", closing: "CLOSE." },
    "permission-prompts": [
      {
        permissions: "tabs",
        prompt: "tabs pre wording",
        max_strict_version: "153",
      },
      {
        permissions: "future",
        prompt: "FUTURE wording",
        min_strict_version: "154",
      },
    ],
  });
  const ctx = {
    manifest: {
      browser_specific_settings: { gecko: { strict_min_version: "128" } },
    },
    recheck: new Map([
      [
        "unused-permission-recheck",
        [
          { item: "future", file: "manifest.json" },
          { item: "tabs", file: "manifest.json" },
        ],
      ],
    ]),
  };
  const { rubric, items } = buildRecheckSections(ctx, reg, "N");
  assert.match(items, /- tabs/); // grounded (pre variant) -> judged
  assert.doesNotMatch(items, /- future/); // ungrounded here -> dropped, falls to manual
  assert.doesNotMatch(rubric, /FUTURE/);
  // ...and the dropped permission is not lost: the model never saw it (not in items),
  // so it has no verdict and resolveRecheck routes it to manual review.
  const resolved = resolveRecheck(ctx, { id: "unused-permission-recheck" });
  assert.ok(
    resolved.escalations.some((e) => e.item === "future"),
    "the dropped permission must fall to manual review"
  );
});

// The framing (permission-prompt-framing) carries the verdict scheme and the
// judge-only-from-current-code rules that apply to EVERY rechecked permission - the
// per-permission prompts define only what justifies each one. It must always be
// present and wired into the assembled rubric: without it the model would be handed a
// bare "X is justified by Y" with no pass/fail/unsure definition and would guess. No
// per-permission test covers this, so a dropped framing would otherwise pass silently.
test("the assembled rubric always carries the framing verdict scheme", () => {
  const rubric = permRubric(["cookies"], "154"); // framing wraps any single permission
  assert.match(rubric, /verdict pass = justified/);
  assert.match(rubric, /fail = unused/);
  assert.match(rubric, /unsure = you genuinely cannot tell/);
  assert.match(rubric, /Ignore comments, TODOs/); // the judge-current-code-only rule
  // The CLOSING half of the framing: a permission is grounded by the live code OR the
  // manifest (so a manifest-key-only permission such as scripting is not judged unused),
  // and the closing defines the negative verdict the per-permission prompts omit.
  assert.match(rubric, /live code\s+or manifest/);
  assert.match(rubric, /the permission is unused \(verdict fail\)/);
});
