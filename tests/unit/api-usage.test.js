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

// Optional chaining is climbed in full (not cut at the `?.`) and flagged optional, a
// syntactic fact about the chain: the access short-circuits to undefined where the member
// is missing. What that means for the add-on is not decided here.
test("climbs optional-chained member access and flags it", () => {
  const [u] = parseApiUsage(`messenger.foo?.bar();`).usages;
  assert.equal(`${u.root}.${u.segments.join(".")}`, "messenger.foo.bar");
  assert.equal(u.optional, true);
  const [plain] = parseApiUsage(`messenger.foo.bar();`).usages;
  assert.equal(plain.optional, false);
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

// Handing the API object to a function is the same event as aliasing it: the root leaves
// for a parameter whose uses resolve nowhere, so every check reading the usage set is
// blind to what happens to it. Recording it is what lets those checks KNOW they are
// blind - permissions.js fails open on a limitation - so a permission used only through
// such a parameter escalates instead of being reported unused. Left unrecorded, this and
// `const api = browser` differ only in syntax while the scan believes itself sighted.
test("records the API object passed into a call as a limitation", () => {
  const res = parseApiUsage(`
        function makeCollector(api) {
          return { d: (id) => api.messages.getFull(id) };
        }
        const collector = makeCollector(browser);
      `);
  assert.ok(
    res.limitations.some((l) => /aliased\/destructured/.test(l.reason)),
    "the call argument is recorded as a coverage gap"
  );
  // The gap is reported where the object left, so a reader is sent to the right line.
  assert.equal(res.limitations[0].line, 5);

  // `new Wrapper(messenger)` is the same handover.
  assert.ok(
    parseApiUsage(`const w = new Wrapper(messenger);`).limitations.some((l) =>
      /aliased\/destructured/.test(l.reason)
    )
  );
});

// The callee of a chain is not an argument, so an ordinary call through the API object
// stays a resolved usage and records no gap. Without this the limitation would fire on
// essentially every add-on and mean nothing.
test("an ordinary API call is not mistaken for handing the object over", () => {
  const res = parseApiUsage(`browser.messages.list({ folder: f });`);
  assert.deepEqual(
    res.usages.map((u) => `${u.root}.${u.segments.join(".")}`),
    ["browser.messages.list"]
  );
  assert.equal(res.limitations.length, 0);
});
