// Unit tests for the remote-code scanners and check.

import { withManifest } from "./manifest-ctx.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyUrl } from "../../src/scan/url.js";
import {
  scanHtmlRemoteRefs,
  scanHtmlInlineCssRefs,
} from "../../src/scan/html.js";
import { scanCssRemoteRefs } from "../../src/scan/css.js";
import { scanRemoteJs } from "../../src/parse/remote-js.js";
import remoteScript from "../../src/checks/rules/remote-script.js";
import evalCall from "../../src/checks/rules/eval-call.js";
import cspUnsafeEval from "../../src/checks/rules/csp-unsafe-eval.js";
import cspUnsafeInline from "../../src/checks/rules/csp-unsafe-inline.js";
import remoteEval from "../../src/checks/rules/remote-eval.js";
import { getEvalScan } from "../../src/checks/lib/eval-scan.js";
import { formatNote } from "../../src/checks/registry.js";

// ---- url classifier ----
// http(s), protocol-relative //, ftp and wss URLs classify as remote; data:/blob:
// as embedded; relative paths, moz-extension:, fragments and "" as local.
test("classifyUrl distinguishes remote / embedded / local", () => {
  for (const u of [
    "https://x/y.js",
    "http://x",
    "//cdn/x.js",
    "ftp://x",
    "wss://x",
  ]) {
    assert.equal(classifyUrl(u), "remote", u);
  }
  assert.equal(classifyUrl("data:text/js,alert(1)"), "embedded");
  assert.equal(classifyUrl("blob:abc"), "embedded");
  for (const u of ["lib/x.js", "/lib/x.js", "moz-extension://x", "#frag", ""]) {
    assert.equal(classifyUrl(u), "local", u);
  }
});

// ---- HTML ----
// Remote <script>, stylesheet <link> and <iframe> yield three remote refs
// (kinds script/css/content) while a local <script src> stays classified local.
test("HTML scan flags remote script/link/iframe, ignores local", () => {
  const refs = scanHtmlRemoteRefs(
    `<script src="https://cdn/x.js"></script>
         <script src="local.js"></script>
         <link rel="stylesheet" href="https://cdn/s.css">
         <iframe src="https://evil/p.html"></iframe>`
  );
  const remote = refs.filter((r) => r.klass === "remote");
  assert.equal(remote.length, 3);
  assert.deepEqual(remote.map((r) => r.kind).sort(), [
    "content",
    "css",
    "script",
  ]);
  assert.ok(refs.some((r) => r.kind === "script" && r.klass === "local"));
});

// ---- CSS ----
// A remote @import and a remote url() are reported (kinds import/url); a local
// @import and a relative font url() are ignored.
test("CSS scan flags remote @import and url(), not local", () => {
  const refs = scanCssRemoteRefs(
    `@import url("https://cdn/a.css");
         @import "local.css";
         body { background: url(https://cdn/bg.png); }
         div { background: url("fonts/x.woff"); }`
  );
  const remote = refs.filter((r) => r.klass === "remote");
  assert.deepEqual(remote.map((r) => r.kind).sort(), ["import", "url"]);
});

// A url() inside a CSS comment is skipped and a data: URI containing a literal
// ')' does not break parsing, so only the one genuine remote url() is reported.
test("CSS scan ignores url() in comments and handles ')' inside a data URI", () => {
  const refs = scanCssRemoteRefs(
    `/* see url(https://commented.example.com/x.css) */
     body { background: url("data:image/png;base64,AA)BB"); }
     a { background-image: url(https://cdn.example.com/i.png); }`
  );
  const remote = refs.filter((r) => r.klass === "remote");
  // Only the real remote url() counts: the commented one is a comment node,
  // and the data: URI (with a ')' inside) is embedded, not remote.
  assert.equal(remote.length, 1);
  assert.equal(remote[0].url, "https://cdn.example.com/i.png");
});

// ---- inline CSS in HTML ----
// CSS inside HTML is scanned with the same css scanner, with lines offset to the
// HTML file: a remote @import in a <style> reports at its file line, a remote
// url() in a style= attribute at the element's line, and local refs are ignored.
test("inline CSS scan flags remote @import in <style> and url() in style=", () => {
  const html =
    `<!doctype html>\n` + // line 1
    `<head>\n` + // line 2
    `<style>\n` + // line 3
    `@import url("https://cdn/a.css");\n` + // line 4
    `body { background: url("local.png"); }\n` + // line 5 (local)
    `</style>\n` + // line 6
    `</head>\n` + // line 7
    `<body><div style="background:url(https://cdn/bg.png)"></div></body>`; // line 8
  const remote = scanHtmlInlineCssRefs(html).filter(
    (r) => r.klass === "remote"
  );
  assert.deepEqual(remote.map((r) => [r.kind, r.line]).sort(), [
    ["import", 4],
    ["url", 8],
  ]);
  assert.ok(!remote.some((r) => r.url.includes("local.png")));
});

// remote-script surfaces an inline-<style> remote @import as a finding, exactly
// like a remote ref in a standalone .css file.
test("remote-script flags a remote @import inside an inline <style>", () => {
  const ctx = fakeCtx(
    {
      "page.html": `<head><style>@import url("https://cdn/f.css");</style></head>`,
    },
    { manifest_version: 3, name: "x", version: "1" }
  );
  const items = remoteScript.run(withManifest(ctx)).findings.map((f) => f.item);
  assert.ok(items.some((i) => i.includes("cdn/f.css")));
});

// ---- JS ----
function types(code) {
  return scanRemoteJs(code).hits.map((h) => h.type);
}

// Static import, dynamic import() and importScripts() with remote URLs all flag
// (import as remote-import, importScripts as remote-importscripts); a relative
// "./local.js" import does not.
test("JS scan flags remote imports / importScripts", () => {
  assert.ok(
    types(`import x from "https://cdn/m.js";`).includes("remote-import")
  );
  assert.ok(
    types(`const m = await import("https://cdn/m.js");`).includes(
      "remote-import"
    )
  );
  assert.ok(
    types(`importScripts("https://cdn/w.js");`).includes("remote-importscripts")
  );
  assert.ok(!types(`import x from "./local.js";`).includes("remote-import"));
});

// Dynamic-code sinks are detected: eval (eval), new Function and bare Function()
// (function-constructor), and setTimeout with a string body (string-timer);
// setTimeout with an arrow function is not a string-timer.
test("JS scan flags eval / Function / string timers", () => {
  assert.ok(types(`eval("x");`).includes("eval"));
  assert.ok(
    types(`const f = new Function("return 1");`).includes(
      "function-constructor"
    )
  );
  assert.ok(types(`Function("return 1")();`).includes("function-constructor"));
  assert.ok(types(`setTimeout("doThing()", 10);`).includes("string-timer"));
  assert.ok(
    !types(`setTimeout(() => doThing(), 10);`).includes("string-timer")
  );
});

// getEvalScan reports dynamic-execution hits only for code OUTSIDE the pure
// WebExtension tree. A WebExtension file (here the manifest's background entry)
// cannot run eval & friends without a permissive CSP - reported separately by
// csp-unsafe-* - so its hits are dropped; a non-WebExtension file (here an
// unreferenced privileged-style file, outside the tree) keeps all four hit types,
// including the ambiguous fetch().then(eval) that feeds remote-eval.
test("getEvalScan scopes hits to non-WebExtension files", () => {
  const dyn =
    `eval("x");\n` +
    `const f = new Function("return 1");\n` +
    `setTimeout("doThing()", 0);\n` +
    `fetch(u).then((r) => r.text()).then(eval);\n`;
  const ctx = fakeCtx(
    { "bg.js": dyn, "exp.js": dyn },
    {
      manifest_version: 3,
      name: "x",
      version: "1",
      background: { scripts: ["bg.js"] },
    }
  );
  const hits = getEvalScan(withManifest(ctx)).hits;
  // Every hit is from the non-WebExtension file; the WebExtension file is exempt.
  assert.ok(hits.length > 0);
  assert.ok(
    hits.every((h) => h.file === "exp.js"),
    JSON.stringify(hits)
  );
  // All four hit types survive (the three deterministic checks + remote-eval's).
  const seen = new Set(hits.map((h) => h.type));
  for (const t of [
    "eval",
    "function-constructor",
    "string-timer",
    "ambiguous-fetch-eval",
  ]) {
    assert.ok(seen.has(t), `missing hit type ${t}`);
  }
});

// Assigning a literal remote URL to a created script element's .src is detected
// as remote-script-src (dynamic injection of remote code at runtime).
test("JS scan flags runtime script injection with a literal remote src", () => {
  const t = types(
    `const s = document.createElement("script"); s.src = "https://cdn/x.js";`
  );
  assert.ok(t.includes("remote-script-src"));
});

// A remote <script> inside an HTML string passed to document.write/innerHTML is
// flagged remote-script-html, including when an attribute value contains '>'
// (an AST/HTML parse case the old regex missed); a local src is not flagged.
test("JS scan detects a remote script in injected HTML, even with '>' in an attr", () => {
  assert.ok(
    types(
      `document.write('<script src="https://cdn.example.com/x.js"></script>');`
    ).includes("remote-script-html")
  );
  // The regex version missed this: '>' inside data-x truncated the match.
  assert.ok(
    types(
      `el.innerHTML = '<script data-x="a>b" src="https://cdn.example.com/x.js">';`
    ).includes("remote-script-html")
  );
  assert.ok(
    !types(`document.write('<script src="local.js"></script>');`).includes(
      "remote-script-html"
    )
  );
});

// Non-literal sinks where the URL/code cannot be resolved statically (computed
// import(), computed script .src, fetch().then(eval)) are surfaced as ambiguous-*
// hits so a human can review them rather than being silently dropped.
test("JS scan reports ambiguous (non-literal) cases for review", () => {
  assert.ok(
    types(`const u = base + path; import(u);`).includes("ambiguous-import")
  );
  assert.ok(
    types(
      `const s = document.createElement("script"); s.src = host + "/x.js";`
    ).includes("ambiguous-script-src")
  );
  assert.ok(
    types(`fetch(u).then(r => r.text()).then(eval);`).includes(
      "ambiguous-fetch-eval"
    )
  );
});

// eval-family sinks still flag when accessed via window/globalThis/self
// (window.eval, self.importScripts, window.setTimeout string, new window.Function),
// but an eval method on a non-global object and a non-string global timer do not.
test("JS scan flags eval-family sinks reached via a global object", () => {
  assert.ok(types(`window.eval("x");`).includes("eval"));
  assert.ok(types(`globalThis.eval("x");`).includes("eval"));
  assert.ok(
    types(`self.importScripts("https://cdn/w.js");`).includes(
      "remote-importscripts"
    )
  );
  assert.ok(
    types(`window.setTimeout("doThing()", 10);`).includes("string-timer")
  );
  assert.ok(
    types(`new window.Function("return 1");`).includes("function-constructor")
  );
  // A method named eval on a non-global object must NOT be flagged.
  assert.ok(!types(`myInterpreter.eval("x");`).includes("eval"));
  // A non-string global timer is fine.
  assert.ok(
    !types(`window.setTimeout(() => doThing(), 10);`).includes("string-timer")
  );
});

// The same eval-family sinks accessed via a BRACKETED string property on a global
// (globalThis["eval"], window["Function"]) are the same sinks - a common way to hide
// them (provider_for_google_calendar used globalThis["eval"] over hex-escaped data).
test("JS scan flags eval-family sinks reached via bracketed global access", () => {
  assert.ok(types(`globalThis["eval"]("x");`).includes("eval"));
  assert.ok(types(`window["eval"]("x");`).includes("eval"));
  assert.ok(
    types(`window["Function"]("return 1")();`).includes("function-constructor")
  );
  assert.ok(
    types(`new globalThis["Function"]("return 1");`).includes(
      "function-constructor"
    )
  );
  assert.ok(
    types(`self["importScripts"]("https://cdn/w.js");`).includes(
      "remote-importscripts"
    )
  );
  // Gating preserved: a bracketed "eval" on a NON-global object is not a sink.
  assert.ok(!types(`myInterpreter["eval"]("x");`).includes("eval"));
});

// rel is parsed as space-separated tokens: "alternate stylesheet" matches via
// its stylesheet token, but "stylesheet-x" and "x-preload" are single non-keyword
// tokens and must not match, so only one remote css ref is reported.
test("HTML scan matches rel by whitespace token, not substring", () => {
  const refs = scanHtmlRemoteRefs(
    `<link rel="alternate stylesheet" href="https://cdn/a.css">
         <link rel="stylesheet-x" href="https://cdn/b.css">
         <link rel="x-preload" as="script" href="https://cdn/c.js">`
  );
  const remote = refs.filter((r) => r.klass === "remote");
  // Only the real "stylesheet" token counts; "stylesheet-x"/"x-preload" are
  // single non-keyword tokens and must not match.
  assert.equal(remote.length, 1);
  assert.equal(remote[0].kind, "css");
  assert.equal(remote[0].url, "https://cdn/a.css");
});

// ---- HTML preload links ----
// modulepreload and preload as=script count as remote script sources, preload
// as=style as css, while rel=icon and rel=preconnect are not code sources and
// are ignored.
test("HTML scan flags remote module/script preload links", () => {
  const refs = scanHtmlRemoteRefs(
    `<link rel="modulepreload" href="https://cdn/m.js">
         <link rel="preload" as="script" href="https://cdn/s.js">
         <link rel="preload" as="style" href="https://cdn/s.css">
         <link rel="icon" href="https://cdn/favicon.ico">
         <link rel="preconnect" href="https://cdn">`
  );
  const remote = refs.filter((r) => r.klass === "remote");
  // modulepreload + preload-as-script => script; preload-as-style => css.
  // icon / preconnect are not sources and must be ignored.
  assert.deepEqual(remote.map((r) => r.kind).sort(), [
    "css",
    "script",
    "script",
  ]);
});

// ---- check + manifest CSP ----
function fakeCtx(files, manifest) {
  const map = new Map();
  for (const [k, v] of Object.entries(files)) {
    map.set(k, Buffer.from(v));
  }
  const jsSources = [];
  for (const [file, v] of Object.entries(files)) {
    if (file.endsWith(".js")) {
      jsSources.push({ file, code: v, lineOffset: 0, inline: false });
    }
  }
  return { addon: { files: map, manifest }, jsSources, options: {} };
}

// A manifest CSP with 'unsafe-eval' and 'unsafe-inline' yields two findings
// (severity left to the registry stamp), whereas 'wasm-unsafe-eval' is
// permitted and produces none.
test("csp-unsafe-eval / csp-unsafe-inline flag the CSP, allow wasm-unsafe-eval", () => {
  const bad = fakeCtx(
    {},
    {
      content_security_policy: {
        extension_pages: "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
      },
    }
  );
  assert.equal(cspUnsafeEval.run(withManifest(bad)).length, 1);
  assert.equal(cspUnsafeInline.run(withManifest(bad)).length, 1);

  const ok = fakeCtx(
    {},
    { content_security_policy: "script-src 'self' 'wasm-unsafe-eval'" }
  );
  assert.equal(cspUnsafeEval.run(withManifest(ok)).length, 0);
  assert.equal(cspUnsafeInline.run(withManifest(ok)).length, 0);

  // Both findings anchor on the content_security_policy line of the manifest
  // text (fakeCtx does not put manifest.json in files, so build the ctx here).
  const located = {
    addon: {
      files: new Map([
        [
          "manifest.json",
          Buffer.from(
            '{\n  "manifest_version": 3,\n' +
              "  \"content_security_policy\": { \"extension_pages\": \"script-src 'self' 'unsafe-eval' 'unsafe-inline'\" }\n}\n"
          ),
        ],
      ]),
      manifest: {
        content_security_policy: {
          extension_pages: "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
        },
      },
    },
    jsSources: [],
    options: {},
  };
  assert.equal(cspUnsafeEval.run(withManifest(located))[0].loc.line, 3);
  assert.equal(cspUnsafeInline.run(withManifest(located))[0].loc.line, 3);
});

// A remote host allowed in the CSP script-src directive is flagged with a
// "remote script source" message, since it permits loading off-package code.
test("remote-script flags a remote CSP script-src host", () => {
  const { findings } = remoteScript.run(
    withManifest(
      fakeCtx(
        {},
        { content_security_policy: "script-src 'self' https://cdn.example.com" }
      )
    )
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].item, /cdn\.example\.com/); // the host is the subject (item)
});

// A clean fully-bundled add-on (local JS, no remote CSP or eval) produces zero
// findings from both checks - the negative/no-false-positive baseline.
test("remote-script + eval checks: no findings for a clean bundled add-on", () => {
  const ctx = fakeCtx(
    { "bg.js": "browser.runtime.onInstalled.addListener(() => {});\n" },
    { manifest_version: 3, name: "x", version: "1" }
  );
  assert.equal(remoteScript.run(withManifest(ctx)).findings.length, 0);
  assert.ok(!remoteScript.run(withManifest(ctx)).llm); // no undecidable sites -> no LLM step
  assert.equal(evalCall.run(withManifest(ctx)).length, 0);
  const re = remoteEval.run(withManifest(ctx));
  assert.equal(re.findings.length, 0);
  assert.ok(!re.llm);
});

// ---- investigation notes (ctx.note) ----
// Each scanned site is narrated to the feed via ctx.note with its per-site
// verdict, regardless of the finding (the orchestrator gates/captures the feed).

test("eval checks note each dynamic-code site and the CSP, with verdicts", () => {
  const ctx = fakeCtx(
    { "bg.js": `eval("x"); fetch(u).then(eval);` },
    {
      content_security_policy: {
        extension_pages: "script-src 'self' 'unsafe-eval'",
      },
    }
  );
  const notes = [];
  ctx.note = (file, loc, item, verdict) => notes.push({ file, item, verdict });
  evalCall.run(withManifest(ctx));
  remoteEval.run(withManifest(ctx));
  cspUnsafeEval.run(withManifest(ctx));
  assert.ok(notes.some((n) => n.item === "eval()" && n.verdict === "fail"));
  assert.ok(notes.some((n) => /fetch/.test(n.item) && n.verdict === "unsure"));
  assert.ok(
    notes.some((n) => n.file === "manifest.json" && n.verdict === "fail")
  );
});

test("remote-script notes remote (fail), local code (pass) and ambiguous (unsure)", () => {
  const ctx = fakeCtx(
    {
      "popup.html":
        '<script src="https://cdn/x.js"></script><script src="local.js"></script>',
      "bg.js": "const u = base + p; import(u);",
    },
    { manifest_version: 3, name: "x", version: "1" }
  );
  const notes = [];
  ctx.note = (file, loc, item, verdict) => notes.push({ item, verdict });
  remoteScript.run(withManifest(ctx));
  assert.ok(notes.some((n) => /cdn/.test(n.item) && n.verdict === "fail"));
  assert.ok(
    notes.some((n) => /local\.js/.test(n.item) && n.verdict === "pass")
  );
  assert.ok(notes.some((n) => n.verdict === "unsure"));
});

// The feed line: a padded [verdict] tag aligning the file column, then
// file:line - item (file alone when no line is known).
test("formatNote renders a padded verdict tag and the site", () => {
  // The note is unindented - runChecks prints it at the feed's DETAIL level.
  assert.equal(
    formatNote("bg.js", { line: 4 }, "fetch x", "fail"),
    "• [fail]    bg.js:4 - fetch x"
  );
  assert.equal(
    formatNote("manifest.json", null, "CSP 'unsafe-eval'", "unsure"),
    "• [unsure]  manifest.json - CSP 'unsafe-eval'"
  );
  // The widest tag, [skipped], sets the column; the others pad to align to it.
  assert.equal(
    formatNote("manifest.json", null, "not an Experiment", "skipped"),
    "• [skipped] manifest.json - not an Experiment"
  );
  // The verdict is an enforced contract: an unknown one is a programmer error.
  assert.throws(() => formatNote("f.js", null, "x", "nope"), /verdict/);
  // An artifact label (SCA review) prefixes the site; "" (XPI review) adds nothing.
  assert.equal(
    formatNote("bg.js", { line: 4 }, "fetch x", "fail", "SCA"),
    "• [fail]    [SCA] bg.js:4 - fetch x"
  );
  assert.equal(
    formatNote("bg.js", { line: 4 }, "fetch x", "fail", ""),
    "• [fail]    bg.js:4 - fetch x"
  );
});
