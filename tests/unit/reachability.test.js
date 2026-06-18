// Unit tests for the reference-graph / reachability layer and the two checks
// built on it (unused-files, minimize-web-accessible-resources).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildReachability } from "../../src/checks/lib/reachability.js";
import { collectJsSources } from "../../src/addon/sources.js";
import { loadSchemaFiles } from "../../src/schema/load.js";
import { buildSchemaIndex } from "../../src/schema/index.js";
import unusedFiles from "../../src/checks/rules/unused-files.js";
import minimizeWar from "../../src/checks/rules/minimize-web-accessible-resources.js";
import { loaderTrace } from "../../src/checks/lib/util.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureSchema = buildSchemaIndex(
  loadSchemaFiles(path.join(here, "..", "schema-fixture"))
);

// Build a review ctx from a {path: content} map + manifest object.
function ctxFrom(files, manifest) {
  const addon = {
    files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
    manifest,
  };
  return { addon, jsSources: collectJsSources(addon) };
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
  const ctx = ctxFrom(files, manifest);
  ctx.schema = fixtureSchema;
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
  const ctx = ctxFrom(files, manifest);
  ctx.schema = fixtureSchema;
  const reach = buildReachability(ctx);
  assert.ok(reach.reachable.has("inject.js")); // schema-derived register
  assert.ok(reach.reachable.has("page.html")); // bridge tabs.create
});

// unused-files pre-flight: junk and a clearly-orphaned file are findings (the
// registry stamps their severity); a file whose name is only string-mentioned
// is an ambiguous case the rule escalates (the orchestrator decides its fate);
// allowlisted and reachable files are left alone entirely.
// With no token every candidate is "unsure"; the check's resolve then yields the
// manual notes (one per ambiguous file F) the orchestrator routes to a human.
const allUnsure = (candidates) =>
  new Map((candidates ?? []).map((c) => [c.id, { verdict: "unsure" }]));
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
  // Localized README variants are docs too, neither flagged nor escalated.
  for (const doc of ["README.md", "README_DE.md"]) {
    assert.ok(!found.includes(doc) && !manual.includes(doc));
  }
  assert.ok(!found.includes("bg.js")); // reachable
});

// Docs/metadata the add-on ships (Description.md, README.md, ...) are allowlisted
// by NAME, but only with a documentation extension or none - a code file that
// merely shares the name (history.js, README.js) is NOT exempt and stays subject
// to the unused-files check, so the allowlist cannot hide code.
test("unused-files: docs allowlisted by name; same-named code still flagged", () => {
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `console.log(1);`,
    "Description.md": "# store listing",
    "Description_DE.md": "# localized variant",
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
  assert.equal(maybe.verdict, "unsure");
  assert.equal(maybe.item, "referenced by bg.js:1"); // referrer file:line traced

  const orphan = notes.find((n) => n.file === "orphan.js");
  assert.equal(orphan.verdict, "fail");
  assert.equal(orphan.item, "referenced by no loaded file");

  // The name-based junk branch is narrated too, so the feed trail is complete.
  assert.deepEqual(
    notes.find((n) => n.file === ".DS_Store"),
    {
      file: ".DS_Store",
      item: "hidden/junk file",
      verdict: "fail",
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

// minimize-WAR pre-flight: over-broad resource pattern and matches are findings;
// a concrete resource no content script loads is a finding; a loaded one is fine.
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
  assert.ok(items.includes("<all_urls>")); // over-broad matches
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
