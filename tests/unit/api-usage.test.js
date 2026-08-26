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

// A whole-object alias of the API object is followed, so calls through it resolve
// to real usages (canonical root) and are NOT reported as a coverage gap. Covers
// the direct, ||/??-chain, and the Thunderbird feature-detection ternary shapes.
test("follows a whole-object API alias (direct, ||, ternary)", () => {
  const direct = parseApiUsage(`const api = browser; api.messages.list();`);
  assert.deepEqual(
    direct.usages.map((u) => `${u.root}.${u.segments.join(".")}`),
    ["browser.messages.list"]
  );
  assert.equal(direct.limitations.length, 0); // resolved, not a gap

  const orChain = parseApiUsage(
    `const api = messenger || browser || chrome; api.messages.update(id, {});`
  );
  assert.deepEqual(
    orChain.usages.map((u) => `${u.root}.${u.segments.join(".")}`),
    ["messenger.messages.update"]
  );

  // The exact shape spamshield uses: a nested typeof feature-detection ternary.
  const ternary = parseApiUsage(
    `const api = (typeof messenger !== "undefined" ? messenger : (typeof browser !== "undefined" ? browser : null));
     api.messages.tags.list();`
  );
  assert.deepEqual(
    ternary.usages.map((u) => `${u.root}.${u.segments.join(".")}`),
    ["messenger.messages.tags.list"]
  );
  assert.equal(ternary.limitations.length, 0);
});

// A namespace captured into a local (const m = browser.messages) is followed, so
// method calls through it resolve to their full path (m.archive -> messages.archive).
// Feature-detection shims do this; without it the function-level permission
// (messagesMove) is never credited. The capture site also yields the bare namespace.
test("follows a namespace captured into a local", () => {
  const res = parseApiUsage(`const m = browser.messages; m.archive([1]);`);
  assert.deepEqual(
    res.usages.map((u) => `${u.root}.${u.segments.join(".")}`),
    ["browser.messages", "browser.messages.archive"]
  );
  assert.equal(res.limitations.length, 0);
});

// The thinbox shim shape: a root captured through a guarded ternary, then each
// namespace captured through `_root && _root.ns || null`. The name-preserving inner
// calls resolve to messages.archive / messages.delete, and no aliased/unresolved
// limitation is emitted for the namespace local.
test("follows a guarded multi-hop namespace capture (shim shape)", () => {
  const res = parseApiUsage(`
        var _br = (typeof browser !== "undefined") ? browser : null;
        var _brMsgs = _br && _br.messages || null;
        _brMsgs.archive(ids);
        _brMsgs["delete"](ids, true);
    `);
  const found = res.usages.map((u) => `${u.root}.${u.segments.join(".")}`);
  assert.ok(found.includes("browser.messages.archive"));
  assert.ok(found.includes("browser.messages.delete"));
  assert.ok(!res.limitations.some((l) => /aliased/.test(l.reason)));
});

// A literal bracket capture (browser["messages"]) resolves like a dotted one; a
// multi-hop capture (root alias -> namespace alias) resolves the full path too.
test("resolves literal-computed and multi-hop namespace captures", () => {
  const lit = parseApiUsage(`const m = browser["messages"]; m.list();`);
  assert.ok(lit.usages.some((u) => u.segments.join(".") === "messages.list"));

  const hop = parseApiUsage(
    `const a = messenger; const b = a.messages; b.update(1, {});`
  );
  assert.deepEqual(
    hop.usages.map((u) => `${u.root}.${u.segments.join(".")}`),
    ["messenger.messages", "messenger.messages.update"]
  );
});

// A shadowed root defeats a namespace capture too: inside function f(browser) the
// captured local resolves to nothing (the parameter is not the global API object).
test("rejects a namespace capture off a shadowed root", () => {
  const res = parseApiUsage(
    `function f(browser) { const m = browser.messages; m.archive(); }`
  );
  assert.equal(res.usages.length, 0);
});

// A computed/dynamic property in the CAPTURE initializer (const m = browser[key])
// is not name-preserving, so the local resolves to nothing - no phantom segment.
test("does not resolve a dynamically-captured namespace", () => {
  const res = parseApiUsage(`const m = browser[key]; m.archive();`);
  assert.ok(
    !res.usages.some((u) => u.segments.includes("archive")),
    "no phantom archive usage"
  );
});

// Mutually-referential captures terminate (the cycle guard) instead of recursing
// forever, and credit nothing.
test("terminates on a cyclic capture chain", () => {
  const res = parseApiUsage(
    `let a = b.messages; let b = a.accounts; a.list();`
  );
  assert.equal(res.usages.length, 0);
});

// `A && B` is B when A is truthy; the presence guard (A) is never the alias value.
// `const m = browser && makeThing()` must NOT credit the LHS root (resolving the RHS
// only, which does not resolve here) - so no phantom browser.* usage.
test("&& resolves the value (RHS), not the presence guard (LHS)", () => {
  assert.equal(
    parseApiUsage(`const m = browser && makeThing(); m.archive();`).usages
      .length,
    0
  );
  // The shim form `_root && _root.ns` still resolves (the namespace is the RHS).
  assert.deepEqual(
    parseApiUsage(`var _b = browser; var m = _b && _b.messages; m.archive();`)
      .usages.map((u) => `${u.root}.${u.segments.join(".")}`)
      .filter((s) => s.endsWith(".archive")),
    ["browser.messages.archive"]
  );
});

// A local whose initializer is NOT an API root (a plain call/value) is not an
// alias, so calls through it are ignored - neither usage nor limitation.
test("does not treat a non-API local as an alias", () => {
  const res = parseApiUsage(`const api = makeThing(); api.messages.list();`);
  assert.equal(res.usages.length, 0);
  assert.equal(res.limitations.length, 0);
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
  // Every logical operator short-circuits, so each can hold the fallback. `??` is
  // the form feature detection most often takes, and reads a missing API exactly:
  // it takes the right side only when the left is nullish.
  assert.equal(guarded(`const m = messenger.foo ?? messenger.bar;`), true);
  assert.equal(guarded(`const m = messenger.foo || messenger.bar;`), true);
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

// A guard says more than THAT an access is feature-detected: where the access is one
// arm of a short-circuit, it records what the OTHER arm names - the alternative that
// runs instead. That is what lets a consumer tell a cross-browser shim (the other arm
// names an API that exists) from a probe for something that exists nowhere. A test
// names what must be PRESENT to arrive here, so it offers no alternative and records
// nothing; nor does reaching THROUGH a namespace, which throws rather than falling
// back.
test("records what a short-circuit offers as the alternative", () => {
  const refs = (code) =>
    parseApiUsage(code).usages.map((u) => u.guardRefs.map((r) => r.join(".")));
  // Each arm names the other, so the pairing reads the same written either way.
  assert.deepEqual(refs(`const m = browser.menus ?? browser.contextMenus;`), [
    ["contextMenus"],
    ["menus"],
  ]);
  assert.deepEqual(refs(`const m = browser.contextMenus ?? browser.menus;`), [
    ["menus"],
    ["contextMenus"],
  ]);
  // An existence test is not an alternative, and neither is a call reaching through
  // the namespace - both are guarded, but with nothing offered in its place.
  assert.deepEqual(
    refs(`if (browser.menus) { browser.contextMenus.create({}); }`),
    [[], []]
  );
  assert.deepEqual(
    refs(`browser.contextMenus.create({}) || browser.menus.create({});`),
    [[], []]
  );
  // No guard at all, and a guard naming nothing: both leave the list empty.
  assert.deepEqual(refs(`browser.contextMenus.create({});`), [[]]);
  assert.deepEqual(
    refs(`if (typeof browser.contextMenus !== "undefined") { x(); }`),
    [[]]
  );
});

// A guard referencing an API namespace through an ALIAS (const m = browser.messages;
// if (m.future) m.future()) is recognized like a literal-root guard - the call is marked
// guarded. Uses if/&& forms (no typeof), so the signal comes specifically from aliasTarget
// resolving the alias in guardApiRefs, not the typeof shortcut. This is the shape that
// regressed strict-min-version-api on shim/wrapper add-ons.
test("recognizes an alias in a feature-detection guard", () => {
  const guardedFuture = (code) =>
    parseApiUsage(code)
      .usages.filter((u) => u.segments.join(".") === "messages.future")
      .every((u) => u.guarded);
  assert.equal(
    guardedFuture(`const m = browser.messages; if (m.future) m.future();`),
    true
  );
  assert.equal(
    guardedFuture(`const m = browser.messages; m.future && m.future();`),
    true
  );
});

// The thinbox shim shape: a namespace captured through `_root && _root.ns || null`, then
// a call feature-detected via `typeof _ns.member === "function"` in a ternary. The
// consequent call is guarded because the ternary test mentions the `_brF` alias.
test("recognizes an aliased namespace in a typeof-ternary guard (thinbox shape)", () => {
  const res = parseApiUsage(`
        var _br = (typeof browser !== "undefined") ? browser : null;
        var _brF = _br && _br.folders || null;
        var f = (typeof _brF.getFolder === "function")
          ? _brF.getFolder(id)
          : legacy(id);
    `);
  const calls = res.usages.filter(
    (u) => u.segments.join(".") === "folders.getFolder"
  );
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((u) => u.guarded));
});

// No over-broadening: a guard test referencing a NON-API local (a plain boolean flag) is
// not a feature-detection signal, so the call stays unguarded.
test("a non-API flag in a guard is not a signal", () => {
  const [fut] = parseApiUsage(
    `const ready = computeReady(); if (ready) browser.messages.future();`
  ).usages.filter((u) => u.segments.join(".") === "messages.future");
  assert.equal(fut.guarded, false);
});

// A property NAME in a guard test is not a value reference: `flag.something` must not
// resolve `something` as an alias even when a variable `something` aliases an API. Only
// value-position identifiers count as a feature-detection signal.
test("a property name coincidentally aliasing an API is not a guard signal", () => {
  const [fut] = parseApiUsage(
    `const something = browser; if (flag.something) browser.messages.future();`
  ).usages.filter((u) => u.segments.join(".") === "messages.future");
  assert.equal(fut.guarded, false);
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

// A root named on the global object grounds its permissions like the bare name:
// the chain resolves to the same path, and to exactly ONE usage. The count is the
// point - the index holds the member that names the root, not the identifier for
// the global object, so a chain climbing from its base cannot collect the root as
// a segment and report the usage a second time.
test("a chain rooted on the global object yields one usage, same as the bare name", () => {
  assert.deepEqual(segments(`globalThis.browser.tabs.create({url: "a"});`), [
    "browser.tabs.create",
  ]);
  assert.deepEqual(segments(`window.chrome.messages.getFull(1);`), [
    "chrome.messages.getFull",
  ]);
  // A bare chain is one usage.
  assert.deepEqual(segments(`browser.messages.getFull(1);`), [
    "browser.messages.getFull",
  ]);
  // A capture is two sites, so two usages: the namespace where it is taken and
  // the call made through it.
  assert.deepEqual(segments(`const m = browser.messages; m.getFull(1);`), [
    "browser.messages",
    "browser.messages.getFull",
  ]);
});

// A feature test written on the global object is a guard like any other, so the
// usages it protects are not reported as unsupported.
test("a feature test on the global object marks the usages it guards", () => {
  const usages = parseApiUsage(
    `if (globalThis.browser.messages.future) { globalThis.browser.tabs.create({url: "a"}); }`
  ).usages;
  assert.ok(usages.length > 0);
  assert.ok(
    usages.every((u) => u.guarded),
    JSON.stringify(usages)
  );
});
