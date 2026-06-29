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

// A real script-affecting unsafe-inline still flags (regression guard).
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
