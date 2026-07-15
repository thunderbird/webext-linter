// Unit tests for the scheme (cleartext) and host fields scanNetworkSinks records
// on each sink - the data the cleartext-transmission and privacy-policy checks
// read. The channel/destClass/dataAppended/carriesData fields are covered in
// rules.test.js alongside the checks that consume them.

import { test } from "node:test";
import assert from "node:assert/strict";

import { scanNetworkSinks } from "../../src/parse/network-sinks.js";

const one = (code) => scanNetworkSinks(code).hits[0];

// Non-TLS schemes (http/ws/ftp) are cleartext; their TLS variants are not. The
// host is parsed from the scheme://host authority.
test("scanNetworkSinks marks cleartext schemes and extracts the host", () => {
  const http = one('fetch("http://api.example.com/collect");');
  assert.equal(http.cleartext, true);
  assert.equal(http.host, "api.example.com");
  assert.equal(http.destClass, "remote");

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
  assert.equal(hit.destClass, "local");
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
    assert.equal(hit.destClass, "local", url);
    assert.equal(hit.cleartext, false, url);
    assert.equal(hit.host, null, url);
  }
  const ws = one('new WebSocket("ws://127.0.0.1:1234/");');
  assert.equal(ws.destClass, "local");
  assert.equal(ws.cleartext, false);
});

// The concat-prefix loopback form ("http://127.0.0.1:" + port) resolves the host
// from the static prefix and is likewise local.
test("a concat-prefix loopback URL is local (no cleartext, no dataAppended)", () => {
  const hit = one('fetch("http://127.0.0.1:" + port + "/x");');
  assert.equal(hit.destClass, "local");
  assert.equal(hit.cleartext, false);
  assert.equal(hit.dataAppended, false);
});

// A real remote host is unaffected by the loopback exemption - including a
// hostname that merely starts with "127." (only all-numeric 127.x is loopback).
test("a real remote http sink still flags cleartext after the loopback fix", () => {
  const hit = one('fetch("http://api.example.com/collect");');
  assert.equal(hit.destClass, "remote");
  assert.equal(hit.cleartext, true);
  assert.equal(hit.host, "api.example.com");

  const hostlike = one('fetch("http://127.example.com/collect");');
  assert.equal(hostlike.destClass, "remote");
  assert.equal(hostlike.cleartext, true);
  assert.equal(hostlike.host, "127.example.com");
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
  assert.equal(hit.channel, "overt");
  assert.equal(hit.destClass, "remote");
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
  assert.equal(dyn.destClass, "dynamic");
});

// A form with no action set, and a .submit() on an untracked element, are not
// flagged (conservative: only a tracked, action-bearing built form).
test("form-submit without a tracked form or an action is not flagged", () => {
  assert.equal(scanNetworkSinks("document.forms[0].submit();").hits.length, 0);
  assert.equal(scanNetworkSinks("widget.submit();").hits.length, 0);
  // Tracked form but no action -> local destination, not an outbound transmission.
  const noAction = one('const f = document.createElement("form"); f.submit();');
  assert.equal(noAction.type, "form-submit");
  assert.equal(noAction.destClass, "local");
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
