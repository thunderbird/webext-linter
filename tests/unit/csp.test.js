// Unit tests for analyzeCsp: the 'unsafe-eval'/'unsafe-inline' keywords and the
// remote host scan are scoped to the script-governing directive (script-src, or
// default-src as its fallback). A keyword in style-src (or any non-script
// directive) is style/asset policy, not code execution, and must not flag.

import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzeCsp } from "../../src/scan/csp.js";

const csp = (s) => analyzeCsp({ content_security_policy: s });

// The reported FP: 'unsafe-inline' in style-src must not trip unsafeInline,
// because scripts inherit default-src 'self' (no inline-script execution).
test("style-src 'unsafe-inline' does not flag unsafeInline", () => {
  const r = csp("default-src 'self'; style-src 'self' 'unsafe-inline'");
  assert.equal(r.unsafeInline, false);
  assert.equal(r.unsafeEval, false);
});

// A real script-affecting unsafe-inline flags: narrowing to the script directive must
// not cost the true positive.
test("script-src 'unsafe-inline' flags unsafeInline", () => {
  assert.equal(csp("script-src 'self' 'unsafe-inline'").unsafeInline, true);
});

// default-src is the fallback for scripts when no script-src is present.
test("default-src 'unsafe-eval' (no script-src) flags unsafeEval", () => {
  const r = csp("default-src 'self' 'unsafe-eval'");
  assert.equal(r.unsafeEval, true);
});

// 'unsafe-eval' in a non-script directive is not code execution.
test("style-src 'unsafe-eval' does not flag unsafeEval", () => {
  const r = csp("script-src 'self'; style-src 'unsafe-eval'");
  assert.equal(r.unsafeEval, false);
  assert.equal(r.unsafeInline, false);
});

// script-src wins over default-src for scripts: a clean script-src is not
// overridden by an unsafe default-src.
test("a clean script-src is not tripped by an unsafe default-src", () => {
  const r = csp("default-src 'unsafe-inline'; script-src 'self'");
  assert.equal(r.unsafeInline, false);
});

// Remote hosts are still read from the script directive only.
test("remoteHosts come from the script-src directive", () => {
  const r = csp(
    "script-src 'self' https://cdn.example.com; img-src https://img.example.com"
  );
  assert.deepEqual(r.remoteHosts, ["https://cdn.example.com"]);
});

// A policy with no script-governing directive permits nothing (scripts fall to
// the restrictive platform default).
test("no script-src/default-src directive flags nothing", () => {
  const r = csp("style-src 'unsafe-inline'; img-src https://img.example.com");
  assert.equal(r.unsafeInline, false);
  assert.equal(r.unsafeEval, false);
  assert.deepEqual(r.remoteHosts, []);
});

// MV3 object form: each named policy string is scoped the same way.
test("MV3 object CSP scopes per policy string", () => {
  const r = analyzeCsp({
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'",
    },
  });
  assert.equal(r.unsafeEval, true);
  assert.equal(r.unsafeInline, false);
});

// ---- directives are read by name, never by position ----

// A policy is tokenized into directives and each question asked of the one that governs
// it, so the order directives are written in changes nothing - including where a
// script-src-elem or script-src-attr comes first.
test("directive order never changes the answer", () => {
  const parts = [
    "script-src 'self' 'unsafe-eval' https://cdn.example.com",
    "script-src-elem 'self'",
    "script-src-attr 'none'",
    "object-src 'self'",
  ];
  const orders = [
    [0, 1, 2, 3],
    [1, 0, 2, 3],
    [2, 0, 1, 3],
    [1, 2, 3, 0],
    [3, 2, 1, 0],
  ];
  for (const order of orders) {
    const r = csp(order.map((i) => parts[i]).join("; "));
    assert.equal(r.unsafeEval, true, order.join(","));
    assert.deepEqual(
      r.remoteHosts,
      ["https://cdn.example.com"],
      order.join(",")
    );
  }
});

// script-src-elem governs <script> elements, so 'unsafe-inline' there allows inline
// script whatever script-src says; eval is never script-src-elem's to allow.
test("each kind of script is governed by its own directive", () => {
  const r = csp(
    "script-src 'self'; script-src-elem 'self' 'unsafe-inline' 'unsafe-eval'"
  );
  assert.equal(r.unsafeInline, true);
  assert.equal(r.unsafeEval, false);
  assert.equal(
    csp("script-src 'self'; script-src-attr 'unsafe-inline'").unsafeInline,
    true
  );
  // A remote host for workers is a remote script source too.
  assert.deepEqual(
    csp("script-src 'self'; worker-src https://w.example.com").remoteHosts,
    ["https://w.example.com"]
  );
});

// A directive declared twice keeps its first declaration; names and keywords are read
// without regard to case.
test("a repeated directive keeps its first declaration, case does not matter", () => {
  assert.equal(
    csp("script-src 'self'; script-src 'unsafe-eval'").unsafeEval,
    false
  );
  assert.equal(csp("SCRIPT-SRC 'Unsafe-Eval'").unsafeEval, true);
  assert.equal(csp("Default-Src 'self' 'UNSAFE-INLINE'").unsafeInline, true);
});

// A nonce, a hash or 'strict-dynamic' makes a browser ignore 'unsafe-inline' in the same
// list. A nonce or hash counts in the form Gecko parses (a base64 value, a closing quote);
// one that does not parse is dropped and cancels nothing. The value itself is not checked.
test("'unsafe-inline' beside a nonce, hash or 'strict-dynamic' allows nothing", () => {
  for (const cancel of [
    "'nonce-abc'",
    "'nonce-YWJj=='",
    "'sha256-xyz'",
    "'SHA384-xyz'",
    "'sha512-xyz'",
    "'strict-dynamic'",
  ]) {
    assert.equal(
      csp(`script-src 'self' 'unsafe-inline' ${cancel}`).unsafeInline,
      false,
      cancel
    );
  }
  for (const malformed of [
    "'nonce-!'",
    "'sha256-'",
    "'nonce-abc",
    "'sha256-a=b'",
  ]) {
    assert.equal(
      csp(`script-src 'self' 'unsafe-inline' ${malformed}`).unsafeInline,
      true,
      malformed
    );
  }
  // Only in the same list: a nonce in another directive cancels nothing.
  assert.equal(
    csp("script-src 'self' 'unsafe-inline'; style-src 'nonce-abc'")
      .unsafeInline,
    true
  );
});

// The MV3 object form: each named policy is read on its own.
test("each MV3 policy is read on its own", () => {
  const r = analyzeCsp({
    content_security_policy: {
      extension_pages:
        "script-src-elem 'self'; script-src 'self' 'unsafe-eval'",
      sandbox: "sandbox; script-src 'self'",
    },
  });
  assert.equal(r.unsafeEval, true);
});

// Every fallback link, each pinned on its own.
test("each fallback chain is followed link by link", () => {
  // script-src-attr falls back to script-src.
  assert.equal(
    csp("script-src 'unsafe-inline'; script-src-elem 'self'").unsafeInline,
    true
  );
  // Workers fall back to child-src before script-src.
  assert.deepEqual(
    csp("script-src 'self'; child-src https://c.example.com").remoteHosts,
    ["https://c.example.com"]
  );
  // ...and to script-src before default-src.
  assert.deepEqual(
    csp("script-src 'self'; default-src https://d.example.com").remoteHosts,
    []
  );
  // script-src-elem's own hosts count.
  assert.deepEqual(
    csp("script-src 'self'; script-src-elem https://e.example.com").remoteHosts,
    ["https://e.example.com"]
  );
  // A repeated name in another case is the same directive: the first one wins.
  assert.equal(
    csp("script-src 'self'; SCRIPT-SRC 'unsafe-eval'").unsafeEval,
    false
  );
  // A tab separates tokens like a space.
  assert.equal(csp("script-src\t'unsafe-eval'").unsafeEval, true);
});

// Gecko drops a directive holding any character outside printable ASCII before it looks
// for duplicates, so a later declaration of that name is the one in force.
test("a directive Gecko drops claims no name", () => {
  assert.equal(
    csp("script-src 'self' \u00e9; script-src 'self' 'unsafe-eval'").unsafeEval,
    true
  );
  assert.equal(
    csp("script-src 'self' 'unsafe-eval' \u000b; script-src 'self'").unsafeEval,
    false
  );
});

// A remote script source is one a script can be fetched over the network by: a URL with a
// network scheme, a network scheme alone, or `*`. A source with no scheme takes the add-on's
// own moz-extension: scheme, so it names nothing remote.
test("remote sources are the ones with a network scheme, or *", () => {
  assert.deepEqual(
    csp(
      "script-src 'self'; script-src-elem 'self' https: * wss://w.example.com"
    ).remoteHosts,
    ["https:", "*", "wss://w.example.com"]
  );
  assert.deepEqual(
    csp(
      "script-src 'self' cdn.example.com //x.example.com data: blob: moz-extension://abc"
    ).remoteHosts,
    []
  );
});
