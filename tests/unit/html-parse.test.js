// Tests for HTML parsing via parse5 — the cases that the old regex scanner got
// wrong, especially an attribute value containing ">".

import { test } from "node:test";
import assert from "node:assert/strict";

import { collectJsSources } from "../../src/addon/sources.js";
import { scanHtmlRemoteRefs } from "../../src/scan/html.js";
import { parseApiUsage } from "../../src/parse/api-usage.js";

function addonWith(file, content) {
  return { files: new Map([[file, Buffer.from(content)]]) };
}

// A '>' inside an attribute value must not fool the parser into ending the tag
// early - the inline code is still captured and its usage line maps back to the
// real HTML line (4) via lineOffset.
test("inline script is extracted with the correct line even when an attribute contains '>'", () => {
  const html = [
    "<!doctype html>",
    "<html><body>",
    '  <script data-tpl="a>b"',
    '          id="x">const y = browser.tabs.query({});</script>',
    "</body></html>",
  ].join("\n");
  const sources = collectJsSources(addonWith("page.html", html));
  assert.equal(sources.length, 1);
  assert.match(sources[0].code, /browser\.tabs\.query/);
  assert.equal(sources[0].lineOffset, 3); // body begins on line 4
  // The reported usage line maps back to the real HTML line (4).
  const usage = parseApiUsage(sources[0].code, sources[0].lineOffset).usages[0];
  assert.equal(usage.line, 4);
});

// An external script (has src) yields no inline source, so only the sibling
// inline script is collected rather than an empty entry for the src tag.
test("a <script src> is not extracted as an inline script", () => {
  const html = '<script src="bg.js"></script><script>browser.foo()</script>';
  const sources = collectJsSources(addonWith("p.html", html));
  assert.equal(sources.length, 1);
  assert.match(sources[0].code, /browser\.foo/);
});

// Even with a '>' in an earlier attribute, the remote-ref scanner resolves the
// single remote script and reports its full https src URL.
test("remote-ref scan parses a tag whose attribute value contains '>'", () => {
  const refs = scanHtmlRemoteRefs(
    '<script data-x="a>b" src="https://cdn.example.com/x.js"></script>'
  );
  const remote = refs.filter(
    (r) => r.klass === "remote" && r.kind === "script"
  );
  assert.equal(remote.length, 1);
  assert.equal(remote[0].url, "https://cdn.example.com/x.js");
});
