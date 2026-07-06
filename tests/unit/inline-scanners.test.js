// Functional unit tests for the four extracted per-file scanners that back the
// core-symbol-in-webext / sync-xhr / debugger-statement / async-onmessage checks.
// Each returns {hits, parseError}; the hits carry the discriminator (name /
// async / guarded) the check uses to decide pass/fail.

import { test } from "node:test";
import assert from "node:assert/strict";

import { scanCoreSymbols } from "../../src/parse/core-symbols.js";
import { scanSyncXhr } from "../../src/parse/sync-xhr.js";
import { scanDebugger } from "../../src/parse/debugger-statement.js";
import { scanAsyncOnMessage } from "../../src/parse/async-onmessage.js";

test("scanCoreSymbols flags a global core symbol", () => {
  const { hits } = scanCoreSymbols("Services.wm.getMostRecentWindow();");
  assert.deepEqual(
    hits.map((h) => h.name),
    ["Services"]
  );
});

test("scanCoreSymbols dedupes one hit per symbol name", () => {
  const { hits } = scanCoreSymbols(
    "Services.a(); Services.b(); ChromeUtils.c();"
  );
  assert.deepEqual(hits.map((h) => h.name).sort(), ["ChromeUtils", "Services"]);
});

test("scanCoreSymbols skips a shadowed local binding and non-core names", () => {
  assert.equal(
    scanCoreSymbols("const Services = x; Services.foo();").hits.length,
    0
  );
  assert.equal(scanCoreSymbols("Foo.bar(); baz();").hits.length, 0);
});

test("scanSyncXhr reports the async flag value (false = sync)", () => {
  const sync = scanSyncXhr('x.open("GET", u, false);').hits;
  const asyncCall = scanSyncXhr('x.open("GET", u, true);').hits;
  assert.deepEqual(
    sync.map((h) => h.async),
    [false]
  );
  assert.deepEqual(
    asyncCall.map((h) => h.async),
    [true]
  );
});

test("scanSyncXhr ignores open() without an explicit boolean third arg", () => {
  assert.equal(scanSyncXhr('x.open("GET", u);').hits.length, 0);
  assert.equal(scanSyncXhr('x.open("GET", u, flag);').hits.length, 0);
});

test("scanDebugger tags an enclosing-if as guarded", () => {
  assert.deepEqual(
    scanDebugger("debugger;").hits.map((h) => h.guarded),
    [false]
  );
  assert.deepEqual(
    scanDebugger("if (dev) { debugger; }").hits.map((h) => h.guarded),
    [true]
  );
});

test("scanAsyncOnMessage flags an async listener across API roots", () => {
  assert.deepEqual(
    scanAsyncOnMessage(
      "browser.runtime.onMessage.addListener(async () => {});"
    ).hits.map((h) => h.async),
    [true]
  );
  assert.deepEqual(
    scanAsyncOnMessage(
      "messenger.runtime.onMessage.addListener(function () {});"
    ).hits.map((h) => h.async),
    [false]
  );
});

test("scanAsyncOnMessage ignores a non-matching addListener shape", () => {
  assert.equal(
    scanAsyncOnMessage("foo.addListener(async () => {});").hits.length,
    0
  );
  assert.equal(
    scanAsyncOnMessage("chrome.tabs.onUpdated.addListener(async () => {});")
      .hits.length,
    0
  );
});
