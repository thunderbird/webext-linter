// Unit tests for src/parse/core-loaders.js: extracting the file arguments an add-on
// hands to an Experiment API (reachability bridges a plain .html parameter into the
// WebExtension tree).

import { test } from "node:test";
import assert from "node:assert/strict";

import { scanExperimentInjectedRefs } from "../../src/parse/core-loaders.js";

// ---- scanExperimentInjectedRefs ----
// File arguments (top level + one level inside an array) of a call into an
// Experiment namespace, via any WebExtension root (browser/messenger/chrome).
// A relative path is root-relative; a scheme URL is by name; a call into a
// non-experiment namespace is ignored.
test("scanExperimentInjectedRefs extracts file args of experiment-namespace calls", () => {
  const ns = new Set(["wl", "ui"]);
  const code = `
    messenger.wl.registerWindow("chrome://x/win.xhtml", "content/entry.js");
    browser.ui.add("content/page.js");
    chrome.wl.list(["a/b.js", "chrome://m/C.js"]);
    messenger.other.run("content/skip.js");
    messenger.wl.noFileArg(42);
  `;
  const got = scanExperimentInjectedRefs(code, ns)
    .refs.map((r) => `${r.ns}:${r.kind}:${r.value}`)
    .sort();
  assert.deepEqual(got, [
    "ui:path:content/page.js",
    "wl:basename:C.js",
    "wl:basename:win.xhtml",
    "wl:path:a/b.js",
    "wl:path:content/entry.js",
  ]);
});

// The callee resolves through the shared api-base index: an aliased root and a
// captured Experiment namespace inject like a direct call (the namespace is the
// first resolved segment), while a shadowed local named like a root does not.
test("scanExperimentInjectedRefs resolves aliased roots and captured namespaces", () => {
  const ns = new Set(["wl"]);
  const code = `
    const api = messenger || browser;
    api.wl.add("content/a.js");
    const wl = messenger.wl;
    wl.registerWindow("content/b.js");
    function f(messenger) { messenger.wl.add("content/skip.js"); }
  `;
  const got = scanExperimentInjectedRefs(code, ns)
    .refs.map((r) => `${r.ns}:${r.kind}:${r.value}`)
    .sort();
  assert.deepEqual(got, ["wl:path:content/a.js", "wl:path:content/b.js"]);
});
