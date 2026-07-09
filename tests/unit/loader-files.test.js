// Unit tests for the file-loader extractor (scanLoaderRefs): schema-directed
// type walking for derived loaders, plus the bridge for schema-unmarked ones.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanLoaderRefs } from "../../src/parse/loader-files.js";
import { loadSchemaFiles } from "../../src/schema/load.js";
import { buildSchemaIndex } from "../../src/schema/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = buildSchemaIndex(
  loadSchemaFiles(path.join(here, "..", "schema-fixture"))
);

/** @param {string} code @returns {string[]} sorted extracted paths. */
const paths = (code, sc = schema) =>
  scanLoaderRefs(code, 0, sc)
    .refs.map((r) => r.path)
    .sort();

// Schema-directed: the fixture marks messageDisplayScripts.register as a loader
// (its js/css items hold a rel-url file). Walking the call against that type
// emits only the file leaves - a sibling non-path value (here a matches glob,
// which the type does not describe) is never collected.
test("schema-directed register extracts only rel-url file leaves", () => {
  const code = `
    messenger.messageDisplayScripts.register({
      js: [{ file: "a.js" }, { file: "b.js" }],
      css: [{ file: "a.css" }],
      matches: ["*://*/*"],
    });
  `;
  assert.deepEqual(paths(code), ["a.css", "a.js", "b.js"]);
});

// A non-literal value at a rel-url leaf is a runtime-built path: no ref, but the
// dynamic flag is set so callers stay conservative.
test("schema-directed loader with a dynamic file value sets hasDynamic", () => {
  const out = scanLoaderRefs(
    `messenger.messageDisplayScripts.register({ js: [{ file: p }] });`,
    0,
    schema
  );
  assert.deepEqual(out.refs, []);
  assert.equal(out.hasDynamic, true);
});

// Without a schema, a derived loader yields nothing (it is not in the bridge),
// while bridge loaders still work - the bridge is schema-independent.
test("derived loaders need the schema; bridge loaders do not", () => {
  const code = `
    messenger.messageDisplayScripts.register({ js: [{ file: "a.js" }] });
    browser.runtime.getURL("page.html");
  `;
  assert.deepEqual(paths(code, null), ["page.html"]);
});

// Bridge getURL: a literal argument is a (root-relative) ref across all three
// API roots; a non-literal argument sets hasDynamic; non-getURL calls are
// ignored.
test("bridge getURL extracts literal paths and flags dynamic ones", () => {
  assert.deepEqual(
    paths(
      `browser.runtime.getURL("page.html");\nmessenger.runtime.getURL("icons/a.png");`
    ),
    ["icons/a.png", "page.html"]
  );

  const d = scanLoaderRefs(`chrome.runtime.getURL(name + ".js");`, 0, schema);
  assert.deepEqual(d.refs, []);
  assert.equal(d.hasDynamic, true);

  // Not runtime.getURL (wrong namespace / not an API root) -> ignored.
  const n = scanLoaderRefs(
    `foo.getURL("x");\nbrowser.tabs.getURL("y");`,
    0,
    schema
  );
  assert.deepEqual(n.refs, []);
  assert.equal(n.hasDynamic, false);
});

// Bridge executeScript/insertCSS: collects every literal path from the singular
// file and the array files arguments across browser/chrome/messenger roots.
test("bridge collects file/files in tabs/scripting executeScript & insertCSS", () => {
  const code = `
    browser.tabs.executeScript({ file: "a.js" });
    chrome.scripting.executeScript({ files: ["b.js", "c.js"] });
    messenger.tabs.insertCSS({ file: "d.css" });
  `;
  assert.deepEqual(paths(code), ["a.js", "b.js", "c.js", "d.css"]);
});

// The details object can be the trailing argument (after a tabId placeholder);
// scanning every object argument means an empty leading {} does not mask it.
test("bridge reads file from the details object, not a leading {}", () => {
  assert.deepEqual(
    paths(`browser.tabs.executeScript({}, { file: "real.js" });`),
    ["real.js"]
  );
});

// No refs from a non-literal file identifier, a func/code injection, an unknown
// receiver, or the wrong runtime namespace - only literal paths under the right
// API surface count.
test("bridge ignores dynamic file values, code injection, and unrelated calls", () => {
  const code = `
    browser.tabs.executeScript({ file: dynamicPath });
    browser.scripting.executeScript({ func: () => {} });
    somethingElse.executeScript({ file: "nope.js" });
    browser.runtime.executeScript({ file: "wrong-namespace.js" });
  `;
  assert.deepEqual(paths(code), []);
});

// Bridge popup/url/panel keys: tabs.create url and the *.setPopup / setPanel
// popup/panel paths are extracted.
test("bridge extracts tabs.create url and *.setPopup paths", () => {
  const code = `
    browser.tabs.create({ url: "page.html" });
    browser.action.setPopup({ popup: "popup.html" });
    messenger.composeAction.setPopup({ popup: "compose.html" });
  `;
  assert.deepEqual(paths(code), ["compose.html", "page.html", "popup.html"]);
});

// Each ref is tagged with the directory its path resolves against at runtime:
// getURL and scripting.* are root-relative ("root"); EVERY other loader (the MV2
// tabs.* injection trio, tabs.create / windows.create url, menus icons,
// *.setPopup, ...) resolves against the calling document, so it is "page". The
// resolver (reachability / bundled-files) uses this tag to pick the base, so the
// tag must come straight from the method name.
test("tags document-relative loaders base:page, root loaders base:root", () => {
  const code = `
    browser.tabs.executeScript({ file: "inject.js" });
    browser.tabs.insertCSS({ file: "style.css" });
    browser.tabs.removeCSS({ file: "old.css" });
    browser.runtime.getURL("page.html");
    browser.scripting.executeScript({ files: ["mv3.js"] });
    browser.tabs.create({ url: "tab.html" });
    browser.composeAction.setPopup({ popup: "pop.html" });
  `;
  const base = Object.fromEntries(
    scanLoaderRefs(code, 0, schema, 2).refs.map((r) => [r.path, r.base])
  );
  // getURL and scripting.* are the only root-relative loaders.
  assert.equal(base["page.html"], "root");
  assert.equal(base["mv3.js"], "root");
  // Everything else resolves against the calling document (host page).
  assert.equal(base["inject.js"], "page");
  assert.equal(base["style.css"], "page");
  assert.equal(base["old.css"], "page");
  assert.equal(base["tab.html"], "page");
  assert.equal(base["pop.html"], "page");
});

// Chain bases resolve through the shared api-base index, so the common
// Thunderbird feature-detection alias and a captured namespace load like a
// direct call - the shape that previously produced unused-files false positives
// (an aliased getURL ref created no reachability edge).
test("resolves loader calls through an aliased root and a captured namespace", () => {
  const code = `
    const api = typeof messenger !== "undefined" ? messenger : browser;
    api.runtime.getURL("help/help.html");
    api.tabs.create({ url: "manager/manager.html" });
    const rt = messenger.runtime;
    rt.getURL("icons/a.png");
    api.messageDisplayScripts.register({ js: [{ file: "display.js" }] });
  `;
  const out = scanLoaderRefs(code, 0, schema);
  assert.deepEqual(
    out.refs.map((r) => `${r.base}:${r.path}`).sort(),
    [
      "page:display.js",
      "page:manager/manager.html",
      "root:help/help.html",
      "root:icons/a.png",
    ].sort()
  );
});

// The nested-getURL exemption in the dynamic-value check follows the alias too:
// a resolved-URL value in a loader slot is not a runtime-built path.
test("an aliased getURL inside a loader url slot does not set hasDynamic", () => {
  const out = scanLoaderRefs(
    `
      const api = messenger || browser;
      api.tabs.create({ url: api.runtime.getURL("page.html") });
    `,
    0,
    schema
  );
  assert.deepEqual(
    out.refs.map((r) => r.path),
    ["page.html"]
  );
  assert.equal(out.hasDynamic, false);
});

// A local named like a root is not the API global - scope-aware resolution
// rejects it where literal-name matching used to accept it.
test("a shadowed root name yields no loader refs", () => {
  const out = scanLoaderRefs(
    `function f(browser) { browser.runtime.getURL("x.html"); }`,
    0,
    schema
  );
  assert.deepEqual(out.refs, []);
});

// Version-specific bridge entries respect the run's manifest version: the
// default action is browserAction in MV2, renamed to action in MV3, and
// tabs.executeScript is MV2-only (scripting.* covers MV3).
test("bridge entries respect the run's manifest version", () => {
  const code = `
    browser.browserAction.setPopup({ popup: "mv2.html" });
    browser.action.setPopup({ popup: "mv3.html" });
    browser.tabs.executeScript({ file: "tabs.js" });
    browser.scripting.executeScript({ files: ["scripting.js"] });
  `;
  const at = (mv) =>
    scanLoaderRefs(code, 0, schema, mv)
      .refs.map((r) => r.path)
      .sort();
  assert.deepEqual(at(2), ["mv2.html", "scripting.js", "tabs.js"]);
  assert.deepEqual(at(3), ["mv3.html", "scripting.js"]);
});
