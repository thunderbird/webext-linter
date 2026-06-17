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
