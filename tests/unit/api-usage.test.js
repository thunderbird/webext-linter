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

// Optional chaining is climbed in full (not cut at the `?.`) and flagged
// optional/guarded, so a consumer can tell the access short-circuits where the
// member is missing.
test("climbs optional-chained member access and flags it", () => {
  const [u] = parseApiUsage(`messenger.foo?.bar();`).usages;
  assert.equal(`${u.root}.${u.segments.join(".")}`, "messenger.foo.bar");
  assert.equal(u.optional, true);
  assert.equal(u.guarded, true);
});

// An optional CALL on the chain (messenger.foo.bar?.()) short-circuits where the
// member is missing - guarded too, even though the members themselves are plain.
test("flags an optional call as guarded", () => {
  const [u] = parseApiUsage(`messenger.foo.bar?.();`).usages;
  assert.equal(u.guarded, true);
  const [plain] = parseApiUsage(`messenger.foo.bar();`).usages;
  assert.equal(plain.guarded, false); // an unconditional call is not guarded
});

// A local guard - an enclosing existence/typeof test or a getBrowserInfo version
// gate referencing an API root - marks the access guarded (a coarse "maybe feature-
// detected" signal); a plain call is neither.
test("flags access inside a local feature-detection guard", () => {
  const guarded = (code) => parseApiUsage(code).usages.every((u) => u.guarded);
  assert.equal(guarded(`if (messenger.foo.bar) messenger.foo.bar();`), true);
  assert.equal(
    guarded(
      `if (typeof messenger.foo.bar === "function") messenger.foo.bar();`
    ),
    true
  );
  assert.equal(guarded(`messenger.foo.bar && messenger.foo.bar();`), true);
  assert.equal(
    guarded(
      `if ((await messenger.runtime.getBrowserInfo()).version >= 141) messenger.x.y();`
    ),
    true
  );

  const [plain] = parseApiUsage(`messenger.foo.bar();`).usages;
  assert.equal(plain.optional, false);
  assert.equal(plain.guarded, false);
});

// The guard must be LOCAL: it does not leak across a function definition, so a
// call in a nested function is not treated as guarded by an outer condition.
test("a guard does not cross a function boundary", () => {
  const [u] = parseApiUsage(
    `if (messenger.foo.bar) { run(() => messenger.foo.bar()); }`
  ).usages.filter((x) => x.segments.join(".") === "foo.bar" && !x.guarded);
  assert.ok(u); // the call inside the arrow is not marked guarded
});

// Unparseable source is handled gracefully: no usages are returned and the
// failure is reported via res.parseError rather than as a thrown exception.
test("reports a parse error without throwing", () => {
  const res = parseApiUsage(`this is (((not valid`);
  assert.equal(res.usages.length, 0);
  assert.ok(res.parseError);
});
