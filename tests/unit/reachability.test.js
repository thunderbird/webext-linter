// Unit tests for the reference-graph / reachability layer and the two checks
// built on it (unused-files, minimize-web-accessible-resources).

import { test } from "node:test";
import { VERDICT } from "../../src/lib/enum.js";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildReachability } from "../../src/lib/reachability.js";
import { manifestStringRefs } from "../../src/lib/manifest-refs.js";
import { collectJsSources } from "../../src/addon/sources.js";
import { loadSchemaFiles } from "../../src/schema/load.js";
import { buildSchemaIndex } from "../../src/schema/index.js";
import unusedFiles from "../../src/checks/rules/unused-files.js";
import minimizeWar from "../../src/checks/rules/minimize-web-accessible-resources.js";
import { loaderTrace } from "../../src/lib/util.js";
import { withManifest, parsedSources } from "./manifest-ctx.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureSchema = buildSchemaIndex(
  loadSchemaFiles(path.join(here, "..", "schema-fixture"))
);

// Build a review ctx from a {path: content} map + manifest object. The schema goes in HERE,
// not onto the ctx afterwards: the extraction pass type-walks the schema-derived loaders
// against it, and a check only ever reads what the pass already extracted.
function ctxFrom(files, manifest, schema) {
  const addon = {
    files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
    manifest,
  };
  return withManifest({
    addon,
    jsSources: parsedSources(addon, { schema }),
    schema,
  });
}

// The graph follows manifest seeds, JS imports/getURL, and HTML/CSS references
// (resolved relative to the referencing file); an unreferenced file is not
// reachable.
test("reachability follows manifest + import + getURL + HTML/CSS edges", () => {
  const manifest = {
    manifest_version: 3,
    background: { scripts: ["bg.js"] },
    icons: { 16: "icons/a.png" },
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `import "./lib/util.js";\nbrowser.runtime.getURL("page.html");`,
    "lib/util.js": `export const x = 1;`,
    "page.html": `<link rel="stylesheet" href="style.css"><img src="img/p.png">`,
    "style.css": `@import "base.css"; .a{background:url(bg.png)}`,
    "base.css": ``,
    "bg.png": "",
    "img/p.png": "",
    "icons/a.png": "",
    "orphan.js": `console.log(1);`,
  };
  const reach = buildReachability(ctxFrom(files, manifest));
  for (const f of [
    "bg.js",
    "lib/util.js",
    "page.html",
    "style.css",
    "base.css",
    "bg.png",
    "img/p.png",
    "icons/a.png",
  ]) {
    assert.ok(reach.reachable.has(f), `${f} should be reachable`);
  }
  assert.ok(!reach.reachable.has("orphan.js"));
  assert.equal(reach.hasDynamicLoaders, false);
});

// manifestStringRefs is the seed source: it collects EVERY string in the manifest
// (so any file-reference key, declared or future, becomes a seed), but skips the
// experiment_apis subtree - whose schema/script paths are privileged experiment
// implementation that must never seed the WebExtension tree.
test("manifestStringRefs collects manifest strings but skips experiment_apis", () => {
  const strings = manifestStringRefs({
    manifest_version: 3,
    background: { scripts: ["bg.js"] },
    message_display_scripts: [{ js: ["content.js"], css: ["a.css"] }],
    experiment_apis: {
      wl: { schema: "exp/schema.json", parent: { script: "exp/impl.js" } },
    },
  });
  assert.ok(strings.includes("bg.js"));
  assert.ok(strings.includes("content.js"));
  assert.ok(strings.includes("a.css"));
  // The experiment_apis subtree is skipped entirely.
  assert.ok(!strings.includes("exp/schema.json"));
  assert.ok(!strings.includes("exp/impl.js"));
});

// A file declared under a manifest key the seeder does not special-case
// (message_display_scripts, a Thunderbird key) is still reachable: the generic
// walk seeds every manifest string that resolves to a packaged file, so there is
// no per-key list to fall out of date.
test("reachability seeds a message_display_scripts file (no per-key list)", () => {
  const manifest = {
    manifest_version: 3,
    background: { scripts: ["bg.js"] },
    message_display_scripts: [{ js: ["content.js"], css: ["style.css"] }],
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `console.log(1);`,
    "content.js": `console.log(2);`,
    "style.css": `body{}`,
    "orphan.js": `console.log(3);`,
  };
  const reach = buildReachability(ctxFrom(files, manifest));
  assert.ok(reach.reachable.has("content.js"));
  assert.ok(reach.reachable.has("style.css"));
  assert.ok(!reach.reachable.has("orphan.js"));
});

// webReachable is seeded from content scripts only; a WAR resource a content
// script getURLs is web-reachable, an exposed-but-unloaded one is not. A narrow
// resource glob seeds general reachability; an over-broad "*" does not.
test("webReachable from content scripts; WAR globs expand", () => {
  const manifest = {
    manifest_version: 3,
    content_scripts: [{ js: ["cs.js"], matches: ["*://*/*"] }],
    web_accessible_resources: [
      { resources: ["res/*.png", "*"], matches: ["<all_urls>"] },
    ],
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "cs.js": `browser.runtime.getURL("res/used.png");`,
    "res/used.png": "",
    "res/unused.png": "",
  };
  const reach = buildReachability(ctxFrom(files, manifest));
  assert.ok(reach.webReachable.has("cs.js"));
  assert.ok(reach.webReachable.has("res/used.png"));
  assert.ok(!reach.webReachable.has("res/unused.png"));
  // The narrow "res/*.png" glob seeds both into general reachability.
  assert.ok(reach.reachable.has("res/unused.png"));
});

// pureWebExtensionReachable: the positive WebExtension tree core-symbol gates on -
// reachable from a WebExtension entry over ordinary edges, never crossing into an
// Experiment API. The experiment implementation files are excluded; a plain `.html`
// parameter to an Experiment API (a content page) IS folded in, while an `.xhtml`/`.js`
// parameter (privileged) is not; dead code is excluded too.
test("pureWebExtensionReachable: webext tree + .html experiment params only", () => {
  const manifest = {
    manifest_version: 2,
    background: { scripts: ["bg.js"] },
    experiment_apis: {
      wl: { schema: "exp/schema.json", parent: { script: "exp/impl.js" } },
    },
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js":
      `import "./helper.js";\n` +
      `messenger.wl.openPage("ui/page.html");\n` +
      `messenger.wl.registerWindow("win.xhtml", "overlay.js");`,
    "helper.js": `export const x = 1;`,
    "ui/page.html": `<script src="page.js"></script>`,
    "ui/page.js": `messenger.runtime.getURL("x");`,
    "win.xhtml": ``,
    "overlay.js": `console.log(1);`,
    "exp/impl.js": `var { X } = ChromeUtils.importESModule("resource://e/mod.sys.mjs");`,
    "exp/schema.json": "[]",
    "dead.js": `console.log(1);`,
  };
  const pure = buildReachability(
    ctxFrom(files, manifest)
  ).pureWebExtensionReachable;
  // WebExtension entry + its ordinary import.
  assert.ok(pure.has("bg.js"));
  assert.ok(pure.has("helper.js"));
  // A plain .html experiment param and its standard closure are folded in.
  assert.ok(pure.has("ui/page.html"));
  assert.ok(pure.has("ui/page.js"));
  // An .xhtml / .js experiment param is privileged -> excluded.
  assert.ok(!pure.has("win.xhtml"));
  assert.ok(!pure.has("overlay.js"));
  // Experiment implementation files and dead code are excluded.
  assert.ok(!pure.has("exp/impl.js"));
  assert.ok(!pure.has("dead.js"));
});

// SCA mode: there is no usable reachability tree over the readable source - the
// manifest's BUILT entry points (from the XPI) don't exist in the source layout,
// so the closure would be empty and every WebExtension code check would review
// nothing. Instead the whole source is WebExtension code, minus an Experiment
// subtree named by --sca-exp-source (privileged, non-WebExtension code).
test("SCA mode: pureWebExtensionReachable is all source, minus --sca-exp-source", () => {
  // A built entry the readable source layout does not contain (the SCA mismatch).
  const manifest = {
    manifest_version: 3,
    background: { scripts: ["background.js"] },
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "helper.js": `browser.runtime.id;`, // a non-entry source file
    "experiments/exp.js": `ChromeUtils.import("x");`, // privileged experiment code
  };

  // XPI mode (default): the built entry resolves to nothing in this tree, so a
  // non-entry source file is NOT reviewed - this is exactly the under-review the
  // SCA branch fixes.
  const xpi = buildReachability(ctxFrom(files, manifest));
  assert.ok(!xpi.pureWebExtensionReachable.has("helper.js"));

  // SCA mode, no exp folder: every source file is WebExtension code (incl. the
  // experiment subtree - the deferred false-positive case).
  const sca = buildReachability({ ...ctxFrom(files, manifest), mode: "sca" });
  assert.ok(sca.pureWebExtensionReachable.has("helper.js"));
  assert.ok(sca.pureWebExtensionReachable.has("experiments/exp.js"));

  // SCA mode + --sca-exp-source: the Experiment subtree drops out; the rest stays.
  const scaExp = buildReachability({
    ...ctxFrom(files, manifest),
    mode: "sca",
    scaExpSource: "experiments",
  });
  assert.ok(scaExp.pureWebExtensionReachable.has("helper.js"));
  assert.ok(!scaExp.pureWebExtensionReachable.has("experiments/exp.js"));

  // The SHIPPED view (isShippedView) is not the review source: it uses the closure
  // branch like an XPI review (its entry points resolve against its own files), so
  // the all-source SCA fallback does NOT apply - a non-entry file is not swept in.
  const shipped = buildReachability({
    ...ctxFrom(files, manifest),
    mode: "sca",
    isShippedView: true,
  });
  assert.ok(!shipped.pureWebExtensionReachable.has("helper.js"));
});

// SCA: the reachable / webReachable / isLive views (what minimize-WAR and
// bundled-files read) describe whatever ctx.addon is. Those checks are `input: xpi`,
// so the orchestrator routes them to a context whose addon is the built XPI
// (buildShippedCtx); over it a resource the XPI's own content script loads is
// web-reachable even when the source's pre-build layout would not show it.
test("SCA: reachability over the built XPI describes the XPI", () => {
  const xpiManifest = {
    manifest_version: 3,
    content_scripts: [{ matches: ["*://*/*"], js: ["content.js"] }],
    web_accessible_resources: [
      { resources: ["injected.js"], matches: ["*://*/*"] },
    ],
  };
  const mk = (obj) =>
    new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)]));
  // The built XPI: its content script (the manifest entry) loads injected.js.
  const xpi = {
    files: mk({
      "manifest.json": JSON.stringify(xpiManifest),
      "content.js": `browser.runtime.getURL("injected.js");`,
      "injected.js": ``,
    }),
    manifest: xpiManifest,
  };
  const reach = buildReachability(
    withManifest({
      addon: xpi,
      jsSources: parsedSources(xpi),
      mode: "sca",
    })
  );
  assert.ok(reach.webReachable.has("injected.js"));
  assert.ok(reach.isLive("content.js"));
});

// A non-literal getURL sets hasDynamicLoaders; the basename safety net finds a
// string reference the structured parsers missed.
test("dynamic loaders set the flag; mentionsOf finds bare-name references", () => {
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `const p = "helper.js";\nbrowser.runtime.getURL(p);`,
    "helper.js": `console.log(1);`,
  };
  const reach = buildReachability(ctxFrom(files, manifest));
  assert.equal(reach.hasDynamicLoaders, true);
  assert.ok(!reach.reachable.has("helper.js"));
  const hits = reach.mentionsOf("helper.js", "helper.js");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, "bg.js");
});

// End-to-end with the real fixture schema: it defines messageDisplayScripts.
// register with a rel-url file parameter, so the derivation marks it a loader
// and the file it registers is reachable (no fake schema, no hardcoding).
test("reachability finds files registered via a schema-derived loader", () => {
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `messenger.messageDisplayScripts.register({ js: [{ file: "inject.js" }] });`,
    "inject.js": `console.log(1);`,
  };
  const ctx = ctxFrom(files, manifest, fixtureSchema);
  assert.ok(buildReachability(ctx).reachable.has("inject.js"));
});

// A schema-derived loader (messageDisplayScripts.register, from the fixture
// schema) and a bridge one (tabs.create) both add reachability edges.
test("reachability follows schema-derived and bridge loader APIs", () => {
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `messenger.messageDisplayScripts.register({ js: [{ file: "inject.js" }] });\nbrowser.tabs.create({ url: "page.html" });`,
    "inject.js": `console.log(1);`,
    "page.html": "<html></html>",
  };
  const ctx = ctxFrom(files, manifest, fixtureSchema);
  const reach = buildReachability(ctx);
  assert.ok(reach.reachable.has("inject.js")); // schema-derived register
  assert.ok(reach.reachable.has("page.html")); // bridge tabs.create
});

// A tabs.executeScript({file}) path resolves against the host PAGE's directory
// (Gecko's "current page URL"), not the script's own location. A background PAGE
// in src/ hosts src/background.js there, so "message-unescape.js" resolves to
// src/message-unescape.js next to the page and is reachable, not an orphan.
test("reachability resolves tabs.executeScript file against the host page dir", () => {
  const manifest = {
    manifest_version: 2,
    background: { page: "src/background.html" },
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "src/background.html": `<script src="background.js"></script>`,
    "src/background.js": `browser.tabs.executeScript(id, { file: "message-unescape.js" });`,
    "src/message-unescape.js": `console.log(1);`,
  };
  const reach = buildReachability(ctxFrom(files, manifest));
  assert.ok(reach.reachable.has("src/message-unescape.js"));
});

// unused-files pre-flight: junk and a clearly-orphaned file are findings (the
// registry stamps their severity); a file whose name is only string-mentioned
// is an ambiguous case the rule escalates (the orchestrator decides its fate);
// allowlisted and reachable files are left alone entirely.
// With no token every candidate is "unsure"; the check's resolve then yields the
// manual notes (one per ambiguous file F) the orchestrator routes to a human.
const allUnsure = (candidates) =>
  new Map((candidates ?? []).map((c) => [c.id, { verdict: VERDICT.UNSURE }]));
const manualItems = (result) =>
  result.llm ? result.llm.resolve(allUnsure(result.llm.candidates)).manual : [];

test("unused-files: junk + orphan are findings; mentioned -> candidate", () => {
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `const n = "maybe.js";\nconsole.log(n);`,
    ".DS_Store": "",
    "orphan.js": `console.log(1);`,
    "maybe.js": `console.log(2);`, // string-mentioned in bg.js -> ambiguous
    LICENSE: "MIT",
    "vendor/d3/LICENCE": "ISC", // en-GB spelling, extensionless: allowlisted too
    "README.md": "# x",
    "README_DE.md": "# x", // localized doc variant: allowlisted, not flagged
  };
  const result = unusedFiles.run(ctxFrom(files, manifest));
  const found = result.findings.map((f) => f.file);
  const manual = manualItems(result).map((m) => m.file);
  assert.ok(found.includes(".DS_Store"));
  assert.ok(found.includes("orphan.js"));
  assert.equal(
    result.findings.find((f) => f.file === ".DS_Store").severity,
    null
  );
  assert.ok(manual.includes("maybe.js")); // ambiguous -> a manual note (no token)
  assert.ok(!found.includes("LICENSE") && !manual.includes("LICENSE"));
  const licence = "vendor/d3/LICENCE";
  assert.ok(!found.includes(licence) && !manual.includes(licence));
  // Localized README variants are docs too, neither flagged nor escalated.
  for (const doc of ["README.md", "README_DE.md"]) {
    assert.ok(!found.includes(doc) && !manual.includes(doc));
  }
  assert.ok(!found.includes("bg.js")); // reachable
});

// The mention net is path-aware: a reference whose path resolves to a DIFFERENT
// packaged file must not make an unrelated same-basename file look mentioned. A
// bare basename (no resolvable path) is still caught, so recall is preserved.
test("mentionsOf is path-aware: a path-resolved reference ignores a same-basename namesake", () => {
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `import "./lib/button.js";\n// bare ref to widget.js in a comment`,
    "lib/button.js": `export const x = 1;`,
    "dead/button.js": `export const y = 2;`,
    "dead/widget.js": `export const z = 3;`,
  };
  const reach = buildReachability(ctxFrom(files, manifest));
  // "./lib/button.js" resolves to lib/button.js, NOT to dead/button.js.
  assert.deepEqual(reach.mentionsOf("dead/button.js"), []);
  assert.deepEqual(
    reach.mentionsOf("lib/button.js").map((m) => m.file),
    ["bg.js"]
  );
  // A bare "widget.js" (no resolvable path) still counts.
  assert.deepEqual(
    reach.mentionsOf("dead/widget.js").map((m) => m.file),
    ["bg.js"]
  );
});

// End to end through the check: a genuinely-unused file whose basename collides
// with a referenced library file (e.g. an add-on's own widgets/button.js vs a
// vendored components/button/button.js) is a clear ORPHAN finding, not an
// ambiguous escalation - so it is reported, not hidden behind a manual review.
test("unused-files: a basename colliding with a referenced library file is still an orphan", () => {
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `import "./lib/button.js";`,
    "lib/button.js": `export const x = 1;`,
    "dead/button.js": `export const y = 2;`,
  };
  const result = unusedFiles.run(ctxFrom(files, manifest));
  const found = result.findings.map((f) => f.file);
  const manual = manualItems(result).map((m) => m.file);
  assert.ok(found.includes("dead/button.js"), "collision orphan is a finding");
  assert.ok(!manual.includes("dead/button.js"), "not escalated to manual");
  assert.ok(!found.includes("lib/button.js")); // reachable, used
});

// Docs/metadata the add-on ships are exempt when the basename CONTAINS a known doc
// name and the file is a doc type (a documentation extension or none) - so localized
// variants with any separator (README_DE.md, README.de.md) are covered, while a code
// file that merely shares the name (history.js, README.js) is NOT exempt and stays
// subject to the unused-files check, so the exemption cannot hide code.
test("unused-files: docs allowlisted by name; same-named code still flagged", () => {
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `console.log(1);`,
    "Description.md": "# store listing",
    "Description_DE.md": "# localized variant (underscore)",
    "README.de.md": "# localized variant (dotted)",
    "Description.fr.md": "# localized variant (dotted)",
    "CONTRIBUTING.md": "# how to help",
    "CODE_OF_CONDUCT.md": "# be nice",
    "TODO.md": "- things",
    "history.js": `console.log("orphan code, not a doc");`,
    "README.js": `console.log("not a readme");`,
  };
  const result = unusedFiles.run(ctxFrom(files, manifest));
  const found = result.findings.map((f) => f.file);
  const manual = manualItems(result).map((m) => m.file);
  const flagged = (f) => found.includes(f) || manual.includes(f);
  for (const doc of [
    "Description.md",
    "Description_DE.md",
    "README.de.md",
    "Description.fr.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "TODO.md",
  ]) {
    assert.ok(!flagged(doc), `${doc} should be allowlisted`);
  }
  // A code file (.js) is NOT allowlisted, even when named like a doc/metadata
  // file - neither a doc-prose name nor an existing metadata name gets a pass.
  assert.ok(flagged("history.js"), "history.js should still be flagged");
  assert.ok(flagged("README.js"), "README.js should still be flagged");
});

// The pre-flight narrates each unreachable candidate it assesses to the feed via
// ctx.note, carrying its deterministic verdict (unsure = escalated to the LLM,
// fail = a clear orphan) and the loaders (file:line) it examined - so a reviewer
// can re-check them even though the report shows only the final outcome.
test("unused-files notes the loaders it examined per candidate", () => {
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `const n = "maybe.js";\nconsole.log(n);`, // live referrer
    "maybe.js": `console.log(2);`, // mentioned by reachable bg.js -> unsure
    "orphan.js": `console.log(1);`, // referenced by nothing -> fail
    ".DS_Store": "", // junk by name -> fail
  };
  const ctx = ctxFrom(files, manifest);
  const notes = [];
  ctx.note = (file, loc, item, verdict) => notes.push({ file, item, verdict });
  unusedFiles.run(ctx);

  const maybe = notes.find((n) => n.file === "maybe.js");
  assert.equal(maybe.verdict, VERDICT.UNSURE);
  assert.equal(maybe.item, "referenced by bg.js:1"); // referrer file:line traced

  const orphan = notes.find((n) => n.file === "orphan.js");
  assert.equal(orphan.verdict, VERDICT.FAIL);
  assert.equal(orphan.item, "referenced by no loaded file");

  // The name-based junk branch is narrated too, so the feed trail is complete.
  assert.deepEqual(
    notes.find((n) => n.file === ".DS_Store"),
    {
      file: ".DS_Store",
      item: "hidden/junk file",
      verdict: VERDICT.FAIL,
    }
  );
});

// loaderTrace (shared by unused-files + minimize-WAR) renders the three cases:
// referrers sorted by (file, line) with a dead-code marker when none is live, a
// runtime-loader hint, and the no-loader fallback.
test("loaderTrace formats referrers / dynamic loaders / none", () => {
  const noDyn = { hasDynamicLoaders: false, dynamicLoaderSites: [] };
  assert.equal(
    loaderTrace(
      noDyn,
      [
        { file: "b.js", line: 10 },
        { file: "a.js", line: 5 },
      ],
      true
    ),
    "referenced by a.js:5, b.js:10"
  );
  assert.equal(
    loaderTrace(noDyn, [{ file: "d.js", line: 8 }], false),
    "referenced by d.js:8 (dead code only)"
  );
  assert.equal(loaderTrace(noDyn, [], false), "referenced by no loaded file");
  const dyn = {
    hasDynamicLoaders: true,
    dynamicLoaderSites: [{ file: "bg.js" }],
  };
  assert.equal(
    loaderTrace(dyn, [], false),
    "a runtime loader may build its path (bg.js)"
  );
});

// A README-only reference is documentation, not a runtime load, so the asset
// is a clear orphan (a finding), not an ambiguous "mentioned" case (escalation).
test("unused-files: a doc-only reference does not count as a mention", () => {
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `console.log(1);`,
    "README.md": `![banner](Images/banner.png)`, // only mention is in docs
    "Images/banner.png": "",
  };
  const result = unusedFiles.run(ctxFrom(files, manifest));
  assert.ok(result.findings.some((f) => f.file === "Images/banner.png"));
  assert.ok(!manualItems(result).some((m) => m.file === "Images/banner.png"));
});

// minimize-WAR pre-flight: an over-broad resource pattern is a finding; a
// concrete resource no content script loads is a finding; a loaded one is fine.
// A match like <all_urls> is not a file and is never reported by this check.
test("minimize-WAR flags over-broad exposure and unloaded resources", () => {
  const manifest = {
    manifest_version: 3,
    content_scripts: [{ js: ["cs.js"], matches: ["*://*/*"] }],
    web_accessible_resources: [
      { resources: ["used.png", "unused.png", "*"], matches: ["<all_urls>"] },
    ],
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "cs.js": `browser.runtime.getURL("used.png");`,
    "used.png": "",
    "unused.png": "",
  };
  const items = minimizeWar
    .run(ctxFrom(files, manifest))
    .findings.map((o) => o.item);
  assert.ok(items.includes("*")); // over-broad resource
  assert.ok(!items.includes("<all_urls>")); // a match is not a file - not reported
  assert.ok(items.includes("unused.png")); // exposed but unloaded (unambiguous)
  assert.ok(!items.includes("used.png")); // loaded by a content script
});

// An ambiguous file (mentioned but not statically reached) becomes a candidate
// per suspected loader site; the rule itself never touches the LLM. With no
// token each resolves to a manual note on the file F, and every candidate points
// at the loader site (bg.js) the model would judge.
test("unused-files makes a candidate per ambiguous file's loader site", () => {
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `// see good.js\n// see bad.js`, // mentions both -> both ambiguous
    "good.js": `console.log(1);`,
    "bad.js": `console.log(2);`,
  };
  const result = unusedFiles.run(ctxFrom(files, manifest));
  assert.equal(result.findings.length, 0);
  assert.deepEqual(
    manualItems(result)
      .map((m) => m.file)
      .sort(),
    ["bad.js", "good.js"]
  );
  assert.ok(result.llm.candidates.every((c) => c.file === "bg.js"));
});

// An ambiguous exposed resource becomes a per-loader-site candidate too.
test("minimize-WAR makes a candidate for an ambiguous exposed resource", () => {
  const manifest = {
    manifest_version: 3,
    content_scripts: [{ js: ["cs.js"], matches: ["https://example.com/*"] }],
    web_accessible_resources: [
      { resources: ["maybe.png"], matches: ["https://example.com/*"] },
    ],
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "cs.js": `// references maybe.png by a runtime-built path`,
    "maybe.png": "",
  };
  const result = minimizeWar.run(ctxFrom(files, manifest));
  assert.ok(manualItems(result).some((m) => m.item === "maybe.png"));
});

// A file referenced only by another UNREACHABLE file (with no live dynamic
// loader) is a clear orphan, settled deterministically as a finding - the LLM is
// not asked, because dead code cannot load it.
test("unused-files: a file named only by dead code is a finding", () => {
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `console.log(1);`,
    "dead.html": `<script src="dead.js"></script>`, // unreachable
    "dead.js": `console.log(2);`, // named only by the unreachable dead.html
  };
  const result = unusedFiles.run(ctxFrom(files, manifest));
  const found = result.findings.map((f) => f.file);
  assert.ok(found.includes("dead.html"));
  assert.ok(found.includes("dead.js"));
  assert.ok(!result.llm); // no ambiguous candidates -> no LLM step
});

// A dynamic loader that sits in unreachable code never runs, so it must not set
// hasDynamicLoaders nor drag unrelated orphans to the LLM.
test("unused-files: a dynamic loader in dead code does not force escalation", () => {
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `console.log(1);`,
    "orphan-loader.js": `const p = "x";\nbrowser.runtime.getURL(p);`,
    "asset.png": ``, // unreachable, referenced by nothing
  };
  const reach = buildReachability(ctxFrom(files, manifest));
  assert.equal(reach.hasDynamicLoaders, false); // the dead loader is dropped
  const result = unusedFiles.run(ctxFrom(files, manifest));
  assert.ok(result.findings.map((f) => f.file).includes("asset.png"));
  assert.ok(!result.llm);
});

// minimize-WAR: a resource named only by dead code, with no live dynamic loader,
// is plainly needless exposure - a deterministic finding, not an escalation.
test("minimize-WAR: a resource named only by dead code is a finding", () => {
  const manifest = {
    manifest_version: 3,
    content_scripts: [{ js: ["cs.js"], matches: ["https://example.com/*"] }],
    web_accessible_resources: [
      { resources: ["res.png"], matches: ["https://example.com/*"] },
    ],
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "cs.js": `console.log(1);`, // does not reference res.png
    "dead.html": `<img src="res.png">`, // names res.png, but is unreachable
    "res.png": ``,
  };
  const result = minimizeWar.run(ctxFrom(files, manifest));
  assert.ok(result.findings.map((f) => f.item).includes("res.png"));
  assert.ok(!manualItems(result).some((m) => m.item === "res.png"));
});

// minimize-WAR: a match pattern (e.g. <all_urls>) is not a file and must never
// appear in this resource-minimization finding; and a file exposed by a glob
// anchors on the WAR pattern's line, not the file's coincidental occurrence
// elsewhere in the manifest (here the "icons" field).
test("minimize-WAR: no match patterns reported; globbed files anchor on the pattern line", () => {
  const manifest = {
    manifest_version: 3,
    icons: { 16: "icons/icon16.png", 48: "icons/icon48.png" },
    web_accessible_resources: [
      { resources: ["icons/*"], matches: ["<all_urls>"] },
    ],
  };
  const text = JSON.stringify(manifest, null, 2);
  const files = {
    "manifest.json": text,
    "icons/icon16.png": ``,
    "icons/icon48.png": ``,
  };
  const result = minimizeWar.run(ctxFrom(files, manifest));
  const items = result.findings.map((f) => f.item);
  // The match pattern is not a file - never reported here.
  assert.ok(!items.includes("<all_urls>"));
  // The exposed icon files are reported.
  assert.ok(items.includes("icons/icon16.png"));
  // Anchored on the WAR pattern line ("icons/*"), not the "icons" field line.
  const patLine =
    text.split(/\r?\n/).findIndex((l) => l.includes('"icons/*"')) + 1;
  const iconsFieldLine =
    text.split(/\r?\n/).findIndex((l) => l.includes('"icons/icon16.png"')) + 1;
  assert.notEqual(patLine, iconsFieldLine); // the two tokens are on different lines
  const f16 = result.findings.find((f) => f.item === "icons/icon16.png");
  assert.equal(f16.loc.line, patLine);
});
