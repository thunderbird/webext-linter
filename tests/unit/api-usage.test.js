// Unit tests for the Babel-based API usage extractor.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseApiUsage } from "../../src/parse/api-usage.js";

function segments(code) {
  return parseApiUsage(code).usages.map(
    (u) => `${u.root}.${u.segments.join(".")}`
  );
}

// Confirms browser, messenger, and chrome are all treated as API roots, each
// yielding its full member chain prefixed by the root name.
test("extracts simple member chains for all three roots", () => {
  const found = segments(`
        browser.messages.list();
        messenger.compose.beginNew();
        chrome.runtime.sendMessage({});
    `);
  assert.deepEqual(found, [
    "browser.messages.list",
    "messenger.compose.beginNew",
    "chrome.runtime.sendMessage",
  ]);
});

// Deep multi-level namespaces and event .addListener chains are captured
// whole rather than truncated at the first or second segment.
test("handles dotted sub-namespaces and event listeners", () => {
  const found = segments(`
        browser.messages.tags.list();
        browser.messages.onNewMailReceived.addListener(() => {});
    `);
  assert.deepEqual(found, [
    "browser.messages.tags.list",
    "browser.messages.onNewMailReceived.addListener",
  ]);
});

// A literal string subscript like browser["messages"] resolves to a real
// usage, while a variable subscript is unresolvable so it is logged as a
// computed/dynamic limitation instead.
test("resolves bracket string access, marks dynamic access as a limitation", () => {
  const res = parseApiUsage(
    `browser["messages"].list(); browser.storage[key].get();`
  );
  const found = res.usages.map((u) => u.segments.join("."));
  assert.ok(found.includes("messages.list"));
  assert.ok(res.limitations.some((l) => /computed\/dynamic/.test(l.reason)));
});

// Pulling a namespace off browser via destructuring hides later calls from
// static analysis, so it must surface as an aliased/destructured limitation.
test("records destructuring/aliasing of the API object as a limitation", () => {
  const res = parseApiUsage(`const { messages } = browser; messages.list();`);
  assert.ok(
    res.limitations.some((l) => /aliased\/destructured/.test(l.reason))
  );
});

// A parameter named browser shadows the global API object, so calls on it are
// not real API usage and must yield zero usages.
test("ignores a shadowed local named browser", () => {
  const res = parseApiUsage(`function f(browser) { browser.notAnApi(); }`);
  assert.equal(res.usages.length, 0);
});

// Unparseable source is handled gracefully: no usages are returned and the
// failure is reported via res.parseError rather than as a thrown exception.
test("reports a parse error without throwing", () => {
  const res = parseApiUsage(`this is (((not valid`);
  assert.equal(res.usages.length, 0);
  assert.ok(res.parseError);
});
