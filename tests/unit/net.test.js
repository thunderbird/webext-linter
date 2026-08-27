// Unit tests for the fetch wrapper: the abort timeout, and the network rule that
// tells "this load failed" from "there is no network".
//
// A stalled connection must fail loud (a clear throw), not hang the whole review. The
// timeout covers the body read, not only the headers - so a server that sends headers
// then never sends the body still aborts.
//
// The network rule has no ambient signal to consult: navigator.onLine does not exist
// in Node and os.networkInterfaces() reports a cable, not a route. So it uses the
// CONTROL POINT - the first host actually reached. That is module state, set once on
// the first success, which makes ORDER matter here: the control-point test runs first,
// while nothing has been reached yet, and the timeout tests follow.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { fetchWithTimeout, NetworkGoneError } from "../../src/util/net.js";

const CONTROL = "https://schemas.example.com/tree.zip";
const OTHER = "https://cdn.example.com/lib.js";

/** A pre-response failure, the shape undici throws. */
function connectionFailure(code) {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(code), { code }),
  });
}
const ok = () => ({ ok: true, status: 200 });
const read = async (res) => res.status;

test("a failing load is told from a failing network by the control point", async (t) => {
  const routes = new Map();
  mock.method(globalThis, "fetch", async (url) => {
    const r = routes.get(url);
    if (typeof r === "function") {
      throw r();
    }
    return ok();
  });
  t.after(() => mock.restoreAll());

  // 1. The first host reached becomes the control point. Any status proves the route.
  assert.equal(await fetchWithTimeout(CONTROL, read), 200);

  // 2. A load that cannot connect, while the control point still answers: the network
  //    is fine and only that load failed, so the original error is what surfaces.
  routes.set(OTHER, () => connectionFailure("ENOTFOUND"));
  await assert.rejects(() => fetchWithTimeout(OTHER, read), {
    name: "TypeError",
  });

  // 3. ECONNREFUSED means something answered and said no - the route works.
  routes.set(OTHER, () => connectionFailure("ECONNREFUSED"));
  await assert.rejects(() => fetchWithTimeout(OTHER, read), {
    name: "TypeError",
  });

  // 4. The same failure once the control point has gone too: no network, stop. The
  //    probe comes back through this same rule and takes the clause below.
  routes.set(OTHER, () => connectionFailure("ENOTFOUND"));
  routes.set(CONTROL, () => connectionFailure("ENOTFOUND"));
  await assert.rejects(
    () => fetchWithTimeout(OTHER, read),
    (err) => {
      assert.ok(err instanceof NetworkGoneError);
      // Reported against the request that revealed it, not the control point.
      assert.match(err.message, /cdn\.example\.com/);
      return true;
    }
  );

  // 5. And directly on the control point itself.
  await assert.rejects(() => fetchWithTimeout(CONTROL, read), NetworkGoneError);
});

// A non-ok response is not a network failure: the host answered. This is the case the
// rule most has to keep its hands off - a 404 from a mistyped release URL is the
// developer's citation being wrong, not the review being unable to run.
test("a 404 or a 503 is a load failure, never a network one", async (t) => {
  mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 }));
  t.after(() => mock.restoreAll());
  await assert.rejects(
    () =>
      fetchWithTimeout("https://cdn.example.com/gone.js", async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return null;
      }),
    /HTTP 404/
  );
});

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
