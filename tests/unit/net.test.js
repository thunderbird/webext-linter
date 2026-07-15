// Unit test for fetchWithTimeout: a stalled connection must fail loud (a clear
// throw), not hang the whole review. The timeout covers the body read, not only the
// headers - so a server that sends headers then never sends the body still aborts.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { fetchWithTimeout } from "../../src/util/net.js";

test("fetchWithTimeout aborts a stalled response and throws", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    // Headers sent, body never - the half-open hang the setup fetches must survive.
  });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    await assert.rejects(
      () => fetchWithTimeout(`http://127.0.0.1:${port}/`, (r) => r.text(), 300),
      /timed out after 300ms/
    );
  } finally {
    server.close();
  }
});

test("fetchWithTimeout returns the consumed body on a fast response", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
  });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const text = await fetchWithTimeout(
      `http://127.0.0.1:${port}/`,
      (r) => r.text(),
      5000
    );
    assert.equal(text, "ok\n");
  } finally {
    server.close();
  }
});
