// Tests for HTML parsing via parse5 — the cases that the old regex scanner got
// wrong, especially an attribute value containing ">".

import { test } from "node:test";
import assert from "node:assert/strict";

import { collectJsSources } from "../../src/addon/sources.js";
import { scanHtmlRemoteRefs } from "../../src/scan/html.js";
import { eachElement, visibleText } from "../../src/scan/html-parse.js";
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
  const remote = refs.filter((r) => r.klass.remote && r.kind.script);
  assert.equal(remote.length, 1);
  assert.equal(remote[0].url, "https://cdn.example.com/x.js");
});

// A <template>'s contents live in a separate fragment, which parse5 keeps off
// childNodes - so a walker that does not descend sees nothing there. They are still
// code the page can run: cloning template content into the document carries the
// script's unstarted state, so it executes on insertion. A place every scanner is
// blind to is worth exactly as much to someone hiding code as it is cheap, so the walk
// covers it and the reference scanners see it too.
test("a <script> inside a <template> is a source, like any other", () => {
  const body = `var a=0;${"a=a+1;".repeat(200)}`;
  const page =
    `<html><body><template id="t"><script>${body}</` +
    `script></template></body></html>`;
  const sources = collectJsSources({
    files: new Map([["page.html", Buffer.from(page)]]),
  });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].file, "page.html");
  assert.equal(sources[0].inline, true);
  assert.equal(sources[0].code, body);
});

// Same for the reference scan: a remote <script src> parked in a template still loads
// when the template is used.
test("a remote ref inside a <template> is scanned", () => {
  const page =
    `<html><body><template><script src="https://cdn.example/x.js"></` +
    `script></template></body></html>`;
  const urls = scanHtmlRemoteRefs(page).map((r) => r.url);
  assert.deepEqual(urls, ["https://cdn.example/x.js"]);
});

// ---- XHTML ----
// HTML has no self-closing <script/>: parsed as HTML the tag never closes and the rest
// of the document becomes that script's text, so every later script is invisible. That
// is the shape .xhtml documents use, and .xhtml is what this codebase ties to
// privileged UI. A document that declares itself XML with an <?xml prolog is parsed as
// XML, and the prolog is the signal because it is what the author declared.
const XHTML = `<?xml version="1.0"?>
<window xmlns="http://www.w3.org/1999/xhtml">
<script type="application/javascript" src="a/b.js"/>
<script type="application/javascript" src="c.js"/>
<label value="hello"/>
<script type="application/javascript">boot();</script>
</window>`;

test("a self-closed <script/> does not swallow the rest of an XHTML document", () => {
  const scripts = [];
  eachElement(XHTML, (el) => {
    if (el.tag === "script") {
      scripts.push({
        src: el.attr("src"),
        body: el.rawText?.value.trim() ?? "",
      });
    }
  });
  assert.deepEqual(scripts, [
    { src: "a/b.js", body: "" },
    { src: "c.js", body: "" },
    { src: null, body: "boot();" },
  ]);
});

test("an XHTML element carries its line, and so does an inline body", () => {
  const seen = [];
  eachElement(XHTML, (el) => {
    if (el.tag === "script" && el.attr("src") === null) {
      seen.push([el.line, el.rawText.startLine]);
    }
  });
  assert.deepEqual(seen, [[6, 6]]);
});

// The prolog decides, not the namespace: legacy XHTML 1.0 pages carry an xmlns and are
// served, and parsed, as HTML - so they must keep the HTML rules.
test("an xmlns alone does not switch a document to XML parsing", () => {
  const legacy = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<script src="a.js"/>
<script>never();</script>
</body></html>`;
  let bodies = 0;
  eachElement(legacy, (el) => {
    if (el.tag === "script" && el.rawText?.value.trim()) bodies++;
  });
  // Parsed as HTML the second script is swallowed - which is what a browser does too.
  assert.equal(bodies, 1);
});

// visibleText follows the same choice, so the language check reads XHTML copy.
test("visibleText reads an XML document and skips its script text", () => {
  const text = visibleText(XHTML);
  assert.ok(!text.includes("boot();"));
});

// Wrapping a script in `<![CDATA[ ... ]]>` is the ordinary XHTML idiom - it is how a
// document keeps `<` and `&` out of the parser's way, which is exactly what real code
// needs. The section is its own node wrapping the text, so a lookup that only reads a
// script's direct text child finds nothing and the body reads as empty.
// The body is a LIST of nodes in XML - text, CDATA, comments - so reading only the
// first fragment returns the whitespace before `<![CDATA[`, which is how the idiom is
// almost always written, and every such body reads as empty. Empty bodies are dropped,
// so the code vanishes with nothing said about it.
test("a script body is read whole, whatever it is made of", () => {
  const P = `<?xml version="1.0"?>\n<window xmlns="http://www.w3.org/1999/xhtml">\n`;
  const bodyOf = (markup) => {
    let body = null;
    eachElement(P + markup + "\n</window>", (el) => {
      if (el.tag === "script") body = (el.rawText?.value ?? "").trim();
    });
    return body;
  };
  assert.equal(
    bodyOf(`<script>\n<![CDATA[\nfetch("x")\n]]>\n</script>`),
    'fetch("x")'
  );
  assert.equal(bodyOf(`<script>a();<![CDATA[b();]]></script>`), "a();b();");
  assert.equal(
    bodyOf(`<script><![CDATA[a();]]><![CDATA[b();]]></script>`),
    "a();b();"
  );
  assert.equal(bodyOf(`<script><![CDATA[only();]]></script>`), "only();");
});

// XML attribute names are case-sensitive, so `SRC` is a different attribute from `src`
// and the browser reads them that way. Folding the case collapses them onto one key:
// a decoy `SRC` then hides a real remote `src`, and a `Src` on an inline script makes
// us skip a body the browser runs.
test("XML attribute names keep their case", () => {
  const P = `<?xml version="1.0"?>\n<window xmlns="http://www.w3.org/1999/xhtml">\n`;
  const seen = [];
  eachElement(
    P +
      `<script src="https://remote.example/x.js" SRC="local.js"/>\n` +
      `<script Src="x.js">body()</script>\n</window>`,
    (el) => {
      if (el.tag === "script") {
        seen.push([el.attr("src"), (el.rawText?.value ?? "").trim()]);
      }
    }
  );
  assert.deepEqual(seen, [
    ["https://remote.example/x.js", ""], // the decoy does not mask the real one
    [null, "body()"], // `Src` is not `src`, so this is an inline body
  ]);
});

test("a CDATA-wrapped script body is extracted, operators intact", () => {
  const doc = `<?xml version="1.0"?>
<window xmlns="http://www.w3.org/1999/xhtml">
<script type="application/javascript"><![CDATA[
  function boot(el) { if (a < b && c > d) { el.innerHTML = "x"; } }
]]></script>
</window>`;
  const bodies = [];
  eachElement(doc, (el) => {
    if (el.tag === "script" && el.rawText) {
      bodies.push([el.rawText.startLine, el.rawText.value.trim()]);
    }
  });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0][0], 3);
  assert.match(bodies[0][1], /a < b && c > d/);
});
