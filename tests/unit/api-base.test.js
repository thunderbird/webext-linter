// Unit tests for src/parse/api-base.js: the per-AST API-base index (apiBasesOf)
// and callee-chain resolution through it (calleeApiPath) - the single notion of
// "what denotes a WebExtension API object" every chain-rooting scanner shares.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJs, traverse } from "../../src/parse/ast.js";
import { apiBasesOf, calleeApiPath } from "../../src/parse/api-base.js";

/**
 * Resolve every CallExpression callee in `code` through the index, as
 * "root.seg1.seg2" strings (unresolved callees are dropped).
 * @param {string} code
 * @returns {string[]}
 */
function resolvedCalls(code) {
  const { ast } = parseJs(code);
  const bases = apiBasesOf(ast);
  const out = [];
  traverse(ast, {
    CallExpression(p) {
      const r = calleeApiPath(p.node.callee, bases);
      if (r) {
        out.push(`${r.root}.${r.segments.join(".")}`);
      }
    },
  });
  return out;
}

test("resolves literal roots and whole-object aliases to the same path", () => {
  assert.deepEqual(
    resolvedCalls(`
      browser.runtime.getURL("a.html");
      const api = typeof messenger !== "undefined" ? messenger : browser;
      api.runtime.getURL("b.html");
      const alt = messenger || browser || chrome;
      alt.tabs.create({ url: "c.html" });
      const nc = messenger ?? browser;
      nc.runtime.getURL("d.html");
    `),
    [
      "browser.runtime.getURL",
      "messenger.runtime.getURL",
      "messenger.tabs.create",
      "messenger.runtime.getURL",
    ]
  );
});

// The polyfill shim re-binds the root name itself; the binding's initializer
// still resolves back to a root, so the shim must not blind the resolution.
// The self-reference on the left is unprovable (the cycle guard nulls it), so
// resolution lands on the fallback operand - which root wins is irrelevant,
// the three roots are synonyms to every consumer.
test("resolves a root name re-bound by a polyfill shim", () => {
  assert.deepEqual(
    resolvedCalls(`
      var browser = browser || chrome;
      browser.runtime.getURL("a.html");
    `),
    ["chrome.runtime.getURL"]
  );
});

// String-literal bracket links count as static names, matching the chain climb
// in api-usage and the alias resolution in initializers.
test("resolves string-literal bracket links in the callee chain", () => {
  assert.deepEqual(
    resolvedCalls(`
      browser["runtime"].getURL("a.html");
      const rt = messenger["runtime"];
      rt.getURL("b.html");
    `),
    ["browser.runtime.getURL", "messenger.runtime.getURL"]
  );
});

// An optional-chained initializer capture still names its namespace statically.
test("resolves an optional-member namespace capture", () => {
  assert.deepEqual(
    resolvedCalls(`
      const m = messenger?.messages;
      m.getFull(id);
    `),
    ["messenger.messages.getFull"]
  );
});

test("a captured namespace contributes its prefix to the resolved path", () => {
  assert.deepEqual(
    resolvedCalls(`
      const rt = messenger.runtime;
      rt.getURL("a.html");
      const om = messenger.runtime.onMessage;
      om.addListener(() => {});
    `),
    ["messenger.runtime.getURL", "messenger.runtime.onMessage.addListener"]
  );
});

test("resolves a multi-hop guarded shim capture", () => {
  assert.deepEqual(
    resolvedCalls(`
      const _api = messenger || browser;
      const _m = (_api && _api.messages) || null;
      _m.getFull(id);
    `),
    ["messenger.messages.getFull"]
  );
});

// A local named like a root (a function parameter, a require result) is NOT the
// API global; the index is scope-aware where literal-name matching cannot be.
test("a shadowed root name does not resolve", () => {
  assert.deepEqual(
    resolvedCalls(`
      function f(browser) {
        browser.runtime.getURL("x.html");
      }
    `),
    []
  );
});

test("a computed link or a non-API base yields null", () => {
  assert.deepEqual(
    resolvedCalls(`
      browser[ns].getURL("a.html");
      foo.runtime.getURL("b.html");
      getURL("c.html");
    `),
    []
  );
});

test("an alias cycle terminates without resolving", () => {
  assert.deepEqual(
    resolvedCalls(`
      var a = b;
      var b = a;
      a.runtime.getURL("x.html");
    `),
    []
  );
});

test("the index is built once per AST and tolerates a null AST", () => {
  const { ast } = parseJs(`browser.runtime.getURL("x.html");`);
  assert.equal(apiBasesOf(ast), apiBasesOf(ast));
  assert.ok(apiBasesOf(ast).size >= 1);
  assert.equal(apiBasesOf(null).size, 0);
});
