// Unit tests for the fetch wrapper: the abort timeout, the network rule that tells
// "this load failed" from "there is no network", and the rate gate every outgoing
// request passes through.
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
//
// The gate's own state (the per-host interval) is module state too, so the tests that
// assert spacing set the knobs they need and put them back.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  fetchWithTimeout,
  NetworkGoneError,
  NoAnswerError,
  setNetworkPacing,
  httpError,
  withHttpStatus,
} from "../../src/util/net.js";
import { setProgress, setFeed } from "../../src/util/log.js";
import {
  NETWORK_RETRIES,
  NETWORK_MAX_WAIT_MS,
  NETWORK_ANNOUNCE_WAIT_MS,
} from "../../src/config.js";

// Every request here is answered from a stub, so there is no budget to respect and no
// refusal to back off from - only real seconds to lose. The tests that are ABOUT the
// gate drive the knobs deliberately, and restore this.
setNetworkPacing({ intervalMs: 0, backoffMs: 0 });

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
  //    is fine and that host gave no answer, which the review cannot go on without.
  routes.set(OTHER, () => connectionFailure("ENOTFOUND"));
  await assert.rejects(
    () => fetchWithTimeout(OTHER, read),
    (err) => {
      assert.ok(err instanceof NoAnswerError);
      assert.ok(err.class.no_answer);
      assert.match(err.message, /cdn\.example\.com.*ENOTFOUND/);
      return true;
    }
  );

  // 3. ECONNREFUSED means something answered and said no - the route works, and that
  //    host gave no answer.
  routes.set(OTHER, () => connectionFailure("ECONNREFUSED"));
  await assert.rejects(() => fetchWithTimeout(OTHER, read), NoAnswerError);

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

// A request that reaches no host - a URL that does not parse - is not a host failing to
// answer: the caller reads it like any other failure of its own request.
test("a request that cannot be built is not 'no answer'", async () => {
  await assert.rejects(
    () => fetchWithTimeout("not a url", statusOrThrow),
    (err) => !(err instanceof NoAnswerError) && err instanceof TypeError
  );
});

// A non-ok response is not a network failure: the host answered. This is the case the
// rule most has to keep its hands off - a 404 from a mistyped release URL is the
// developer's citation being wrong, an ANSWER the caller reads, not the review being
// unable to run.
test("a 404 is an answer the caller reads, never a stop", async (t) => {
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
    (err) => !(err instanceof NoAnswerError) && /HTTP 404/.test(err.message)
  );
});

test("fetchWithTimeout aborts a stalled response: no answer", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    // Headers sent, body never - the half-open hang the setup fetches must survive.
  });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    await assert.rejects(
      () => fetchWithTimeout(`http://127.0.0.1:${port}/`, (r) => r.text(), 300),
      (err) =>
        err instanceof NoAnswerError &&
        /timed out after 300ms/.test(err.message)
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

// ---- the rate gate ----
// The bug it exists for: api.npmjs.org answers a burst with 429, and a refusal read as an
// answer demoted one add-on's own library, differently on every run. A refusal is not a
// reading: it is waited out, and one that outlasts the retries ends the review. The gate lives HERE, below every
// transport, so no endpoint added later can forget to pass through it.

const PACED = "https://paced.example.com/thing";

/**
 * Answer a sequence of statuses, then 200s.
 * @param {number[]} statuses  Answered in order; anything after them is a 200.
 * @param {{retryAfter?: string}} [opts]  Sent as Retry-After on every non-200.
 * @returns {{calls: string[]}}  The URLs asked for, in order.
 * @param {number[]} statuses @returns {{calls: string[]}}
 */
function statusSequence(statuses, { retryAfter } = {}) {
  const calls = [];
  const queue = [...statuses];
  mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    const status = queue.shift() ?? 200;
    return {
      ok: status === 200,
      status,
      headers: { get: (h) => (h === "retry-after" ? retryAfter : null) },
    };
  });
  return { calls };
}

/** The consume every gate test uses: the status, or the transport's own error. */
const statusOrThrow = async (res) => {
  if (!res.ok) {
    throw httpError(res);
  }
  return res.status;
};

// A 429 says nothing about what was asked, so the answer is still out there. If this
// stops holding, a popular library is reported as unknown-origin the moment its host is
// busy - and a minified one is REJECTED for it.
test("a 429 is retried, and the retried answer is the one returned", async (t) => {
  const { calls } = statusSequence([429]);
  t.after(() => mock.restoreAll());
  assert.equal(await fetchWithTimeout(PACED, statusOrThrow), 200);
  assert.equal(calls.length, 2, "asked again after the refusal");
});

// The other shapes a host uses to decline. 403 is how api.github.com says it.
test("403, 408 and 5xx are refusals too, not answers", async (t) => {
  t.after(() => mock.restoreAll());
  for (const status of [403, 408, 500, 503]) {
    const { calls } = statusSequence([status]);
    assert.equal(
      await fetchWithTimeout(PACED, statusOrThrow),
      200,
      `${status}`
    );
    assert.equal(calls.length, 2, `${status} was retried`);
    mock.restoreAll();
  }
});

// The line that keeps this from becoming "retry everything": npm really does answer 404
// for a package it has no download data for, and 404 is what the offline fixture harness
// serves for every URL it was not told about. Retrying it would multiply our load to
// re-learn the same thing - and would make every golden fixture pay for it.
test("a 404 is an answer, not a refusal, and is never retried", async (t) => {
  const { calls } = statusSequence([404]);
  t.after(() => mock.restoreAll());
  await assert.rejects(
    () => fetchWithTimeout(PACED, statusOrThrow),
    /HTTP 404/
  );
  assert.equal(calls.length, 1, "asked once");
});

// Nor is a TIMEOUT. A host that declines is worth waiting out; a host that does not
// respond is not, and retrying it would multiply the slowest failure the tool has - the
// mandatory setup downloads wait a minute each, and four of those is a review that looks
// hung rather than one that reports a problem.
test("a timeout is no answer, and it is not retried", async (t) => {
  let calls = 0;
  mock.method(globalThis, "fetch", async (_url, { signal }) => {
    calls++;
    await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  t.after(() => mock.restoreAll());
  await assert.rejects(
    () => fetchWithTimeout(PACED, statusOrThrow, 20),
    (err) =>
      err instanceof NoAnswerError && /timed out after 20ms/.test(err.message)
  );
  assert.equal(calls, 1, "asked once, and not again");
});

// Retrying cannot become waiting forever. When the host never relents it has given no
// answer, and the review stops rather than reading the refusal as one.
test("retries are bounded, and a refusal that outlasts them is no answer", async (t) => {
  const { calls } = statusSequence([429, 429, 429, 429, 429, 429]);
  t.after(() => mock.restoreAll());
  await assert.rejects(
    () => fetchWithTimeout(PACED, statusOrThrow),
    (err) => err instanceof NoAnswerError && /HTTP 429/.test(err.message)
  );
  assert.equal(
    calls.length,
    NETWORK_RETRIES + 1,
    "the first ask plus its retries, and no more"
  );
});

// A Retry-After the host actually names is worth more than our guess. npm sends
// "retry-after: 0" with every 429, which names nothing - hence the fallback backoff.
test("a Retry-After that names a delay wins over the backoff", async (t) => {
  const { calls } = statusSequence([429], { retryAfter: "0.01" });
  t.after(() => {
    mock.restoreAll();
    setNetworkPacing({ backoffMs: 0 });
  });
  setNetworkPacing({ backoffMs: 60000 }); // would hang the suite if preferred
  assert.equal(await fetchWithTimeout(PACED, statusOrThrow), 200);
  assert.equal(calls.length, 2);
});

// The spacing itself, which nothing asserted before: two requests to one host are held
// apart, and a different host is not made to wait behind it.
test("requests to one host are spaced, and other hosts are not held up", async (t) => {
  statusSequence([]);
  t.after(() => {
    mock.restoreAll();
    setNetworkPacing({ intervalMs: 0 });
  });
  setNetworkPacing({ intervalMs: 60 });
  const started = Date.now();
  await fetchWithTimeout("https://a.example.com/1", statusOrThrow);
  await fetchWithTimeout("https://a.example.com/2", statusOrThrow);
  const paced = Date.now() - started;
  assert.ok(paced >= 55, `two asks to one host waited (${paced}ms)`);

  const other = Date.now();
  await fetchWithTimeout("https://b.example.com/1", statusOrThrow);
  assert.ok(
    Date.now() - other < 50,
    "a host asked for the first time does not wait"
  );
});

// TWO THINGS A HOST CAN SAY. Naming a time is an instruction - come back at X - and it
// is obeyed exactly and asked once more. A host that declines again after its own window
// has answered the question, and asking a third time is load it already refused.
test("a named wait is obeyed once, and a second refusal ends it", async (t) => {
  const { calls } = statusSequence([429, 429, 429, 429, 429, 429], {
    retryAfter: "0.01",
  });
  t.after(() => mock.restoreAll());
  await assert.rejects(
    () => fetchWithTimeout(PACED, statusOrThrow),
    (err) => err instanceof NoAnswerError && /HTTP 429/.test(err.message)
  );
  assert.equal(
    calls.length,
    2,
    "asked once more at the time it named, and no more"
  );
});

// ...and when that one ask is answered, the answer is what the caller gets.
test("a named wait that is obeyed gets the answer", async (t) => {
  const { calls } = statusSequence([429], { retryAfter: "0.01" });
  t.after(() => mock.restoreAll());
  assert.equal(await fetchWithTimeout(PACED, statusOrThrow), 200);
  assert.equal(calls.length, 2);
});

// The other case, and the one the ladder exists for: a host that refuses without saying
// when has told us nothing about when either, so the backoff is a guess and gets its
// full count. api.npmjs.org is exactly this - it sends "retry-after: 0" with every 429,
// which names nothing, so it must NOT fall into the obey-once path.
test("a refusal that names no time climbs the full ladder", async (t) => {
  t.after(() => mock.restoreAll());
  for (const retryAfter of [undefined, "0"]) {
    const { calls } = statusSequence([429, 429, 429, 429, 429, 429], {
      retryAfter,
    });
    await assert.rejects(
      () => fetchWithTimeout(PACED, statusOrThrow),
      /HTTP 429/
    );
    assert.equal(
      calls.length,
      NETWORK_RETRIES + 1,
      `retry-after ${JSON.stringify(retryAfter)} names nothing`
    );
    mock.restoreAll();
  }
});

// RFC 9110 lets a host spell the wait as an HTTP-date instead of seconds, and it picks
// either. Read only as a number, a date coerces to NaN and the host reads as one that
// named nothing - which is the one distinction this whole split rests on.
test("an HTTP-date Retry-After is a named time too", async (t) => {
  const { calls } = statusSequence([429], {
    retryAfter: new Date(Date.now() + 1000).toUTCString(),
  });
  t.after(() => mock.restoreAll());
  assert.equal(await fetchWithTimeout(PACED, statusOrThrow), 200);
  assert.equal(calls.length, 2, "obeyed once, like any named time");
});

// A date already past means "now", not a negative wait.
test("an HTTP-date in the past waits no time at all", async (t) => {
  const { calls } = statusSequence([429], {
    retryAfter: new Date(Date.now() - 60000).toUTCString(),
  });
  t.after(() => mock.restoreAll());
  const started = Date.now();
  assert.equal(await fetchWithTimeout(PACED, statusOrThrow), 200);
  assert.ok(Date.now() - started < 500, "did not wait");
  assert.equal(calls.length, 2);
});

// The gate claims its slot BEFORE waiting, so it is a reservation rather than a check.
// Nothing fetches concurrently today; this is what keeps that from being the reason the
// spacing works, because the first Promise.all anyone adds would otherwise un-pace it
// silently, with no test failing.
test("concurrent asks to one host are spaced, not fired together", async (t) => {
  statusSequence([]);
  t.after(() => {
    mock.restoreAll();
    setNetworkPacing({ intervalMs: 0 });
  });
  setNetworkPacing({ intervalMs: 80 });
  const started = Date.now();
  const offsets = await Promise.all(
    [1, 2, 3].map(async () => {
      await fetchWithTimeout("https://together.example.com/x", statusOrThrow);
      return Date.now() - started;
    })
  );
  offsets.sort((a, b) => a - b);
  assert.ok(offsets[1] >= 70, `second waited its turn (${offsets[1]}ms)`);
  assert.ok(offsets[2] >= 150, `third waited two turns (${offsets[2]}ms)`);
});

// A header that scales past what a number can hold names no delay at all - it is not an
// instruction anyone can act on, so it falls to the guess like an absent one.
test("a Retry-After that overflows names nothing", async (t) => {
  t.after(() => mock.restoreAll());
  for (const retryAfter of ["1e308", "1e999"]) {
    const { calls } = statusSequence([429, 429, 429, 429, 429, 429], {
      retryAfter,
    });
    await assert.rejects(
      () => fetchWithTimeout(PACED, statusOrThrow),
      /HTTP 429/
    );
    assert.equal(calls.length, NETWORK_RETRIES + 1, `${retryAfter}`);
    mock.restoreAll();
  }
});

// A named wait is obeyed as given, but "as given" has to end somewhere: a limiter naming
// a day is telling us to come back tomorrow, and a review is something a person is
// waiting on. Past the cap the wait is the cap, and the host is still asked once.
test("a named wait longer than the cap waits the cap, and still asks", async (t) => {
  t.after(() => {
    mock.restoreAll();
    setNetworkPacing({ backoffMs: 0, maxWaitMs: NETWORK_MAX_WAIT_MS });
  });
  // A cap the suite can afford. Without this knob the test would honour the day.
  setNetworkPacing({ backoffMs: 0, maxWaitMs: 20 });
  for (const retryAfter of [
    "86400",
    new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toUTCString(),
  ]) {
    const { calls } = statusSequence([429], { retryAfter });
    const started = Date.now();
    assert.equal(await fetchWithTimeout(PACED, statusOrThrow), 200, retryAfter);
    assert.ok(
      Date.now() - started < 1000,
      `waited the cap, not the ${retryAfter} named`
    );
    assert.equal(calls.length, 2, "and asked once more after it");
    mock.restoreAll();
  }
});

// The cap is a ceiling, not the wait: a named time under it is obeyed exactly.
test("a named wait under the cap is obeyed as given", async (t) => {
  t.after(() => {
    mock.restoreAll();
    setNetworkPacing({ backoffMs: 0, maxWaitMs: NETWORK_MAX_WAIT_MS });
  });
  setNetworkPacing({ backoffMs: 0, maxWaitMs: 60000 });
  const { calls } = statusSequence([429], { retryAfter: "0.2" });
  const started = Date.now();
  assert.equal(await fetchWithTimeout(PACED, statusOrThrow), 200);
  const waited = Date.now() - started;
  assert.ok(waited >= 180, `waited the 200ms it named (${waited}ms)`);
  assert.equal(calls.length, 2);
});

// ---- what the gate says, and to whom ----
// The announcement is the one thing the gate puts on screen, and the reason a long wait
// is acceptable at all: silence for a minute is indistinguishable from a hang. It is
// also the newest output channel in the tool, so these pin both halves of where it goes.

/**
 * Run one refused request with the feed in a given state, and return what was emitted.
 * @param {{feed: boolean, retryAfter?: string, message?: string}} opts
 * @returns {Promise<string>}
 */
async function narrationOf({ feed, retryAfter = "3", message }) {
  const queue = [429];
  mock.method(globalThis, "fetch", async () => {
    const status = queue.shift() ?? 200;
    return {
      ok: status === 200,
      status,
      headers: { get: (h) => (h === "retry-after" ? retryAfter : null) },
    };
  });
  setProgress(true);
  setFeed(feed);
  const consume = async (res) => {
    if (!res.ok) {
      throw withHttpStatus(new Error(message ?? `HTTP ${res.status}`), res);
    }
    return res.status;
  };
  // What the logger actually wrote, read off stdout - the same way log.test.js observes
  // the feed. A line the feed is switched off for is never written, so the
  // `feed: false` case reads as the empty string here exactly as it should.
  // Strings only: the logger writes strings, while the test runner talks to its worker
  // over this same stream in Buffers, which pass through untouched.
  const writes = [];
  const real = process.stdout.write.bind(process.stdout);
  const spy = mock.method(process.stdout, "write", (t, ...rest) =>
    typeof t === "string" ? writes.push(t) : real(t, ...rest)
  );
  try {
    await fetchWithTimeout(PACED, consume);
  } finally {
    spy.mock.restore();
  }
  return writes.join("");
}

test("a long wait says what it is waiting for", async (t) => {
  t.after(() => {
    mock.restoreAll();
    setFeed(true);
    setProgress(false);
    setNetworkPacing({
      maxWaitMs: NETWORK_MAX_WAIT_MS,
      announceMs: NETWORK_ANNOUNCE_WAIT_MS,
    });
  });
  setNetworkPacing({ maxWaitMs: 30, announceMs: 10 });
  const said = await narrationOf({ feed: true });
  // The seconds named are the wait actually taken, not the one the host asked for -
  // here the cap shortened it. What the line has to carry is which host, and why.
  assert.match(said, /Waiting \d+s: paced\.example\.com is refusing requests/);
  assert.match(said, /HTTP 429/);
});

// --llm-review switches the feed off because its output IS the document. A line of ours
// inside it is a line the agent was never given, and it reads them as instructions.
test("with the feed off, the gate says nothing at all", async (t) => {
  t.after(() => {
    mock.restoreAll();
    setFeed(true);
    setProgress(false);
    setNetworkPacing({
      maxWaitMs: NETWORK_MAX_WAIT_MS,
      announceMs: NETWORK_ANNOUNCE_WAIT_MS,
    });
  });
  setNetworkPacing({ maxWaitMs: 30, announceMs: 10 });
  assert.equal(await narrationOf({ feed: false }), "");
});

// `err.message` carries the HOST's own words - an HTTP reason phrase reaches us verbatim.
// An escape sequence in one would rewrite the terminal above it, erasing the review and
// leaving whatever the host wanted in its place.
test("the host's own words cannot rewrite the terminal", async (t) => {
  t.after(() => {
    mock.restoreAll();
    setFeed(true);
    setProgress(false);
    setNetworkPacing({
      maxWaitMs: NETWORK_MAX_WAIT_MS,
      announceMs: NETWORK_ANNOUNCE_WAIT_MS,
    });
  });
  setNetworkPacing({ maxWaitMs: 30, announceMs: 10 });
  const said = await narrationOf({
    feed: true,
    message: "HTTP 429 Busy \u001b[2J\u001b[1;1H  REVIEW PASSED",
  });
  assert.ok(!said.includes("\u001b"), "no escape survived");
  assert.match(said, /REVIEW PASSED/, "the text itself is still shown, inert");
});

// A short wait is not a stall, and narrating every one of them would bury the review's
// own output under the gate's.
test("a wait below the threshold is not announced", async (t) => {
  t.after(() => {
    mock.restoreAll();
    setFeed(true);
    setProgress(false);
    setNetworkPacing({
      maxWaitMs: NETWORK_MAX_WAIT_MS,
      announceMs: NETWORK_ANNOUNCE_WAIT_MS,
    });
  });
  setNetworkPacing({ maxWaitMs: 30, announceMs: 5000 });
  assert.equal(await narrationOf({ feed: true, retryAfter: "0.01" }), "");
});

// ---- the sequences, and who else the gate now covers ----

// Naming a time is the deal: obeyed once, and then believed. It is believed even when
// the host changes HOW it refuses - the second refusal is still the answer to the ask it
// was given its own window for, whether or not it names a time again. The consequence is
// worth seeing plainly: naming a time REDUCES the tool's total patience, because the
// ladder's remaining rungs are forfeited.
test("a named wait then an unnamed refusal ends it, ladder forfeited", async (t) => {
  const calls = [];
  const queue = [
    { status: 429, retryAfter: "0.01" },
    { status: 429, retryAfter: null },
    { status: 429, retryAfter: null },
  ];
  mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    const next = queue.shift() ?? { status: 200, retryAfter: null };
    return {
      ok: next.status === 200,
      status: next.status,
      headers: { get: (h) => (h === "retry-after" ? next.retryAfter : null) },
    };
  });
  t.after(() => mock.restoreAll());
  await assert.rejects(
    () => fetchWithTimeout(PACED, statusOrThrow),
    /HTTP 429/
  );
  assert.equal(calls.length, 2, "the named ask, and nothing after it");
});

// A named time is honoured whatever status carried it - 403 is how api.github.com
// declines, and a 5xx names one as readily as a 429.
test("a named wait is obeyed on any refusal, not just a 429", async (t) => {
  t.after(() => mock.restoreAll());
  for (const status of [403, 408, 500, 503]) {
    const { calls } = statusSequence([status], { retryAfter: "0.01" });
    assert.equal(
      await fetchWithTimeout(PACED, statusOrThrow),
      200,
      `${status}`
    );
    assert.equal(calls.length, 2, `${status} named a time and was obeyed once`);
    mock.restoreAll();
  }
});

// The gate covers the SETUP downloads too, which is most of what moving it bought: they
// used to throw a bare error, so a refusal there was invisible to any retry. They now
// stamp a status (withHttpStatus), which is what makes them retryable at all.
test("a refused setup download is retried, keeping its own wording", async (t) => {
  const calls = [];
  const queue = [503];
  mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    const status = queue.shift() ?? 200;
    return {
      ok: status === 200,
      status,
      headers: { get: () => null },
      arrayBuffer: async () => new TextEncoder().encode("payload").buffer,
    };
  });
  t.after(() => mock.restoreAll());
  // The shape src/util/download.js uses: the caller's own wording, plus the status.
  const consume = async (res) => {
    if (!res.ok) {
      throw withHttpStatus(
        new Error(`Failed to download the schema: HTTP ${res.status}`),
        res
      );
    }
    return Buffer.from(await res.arrayBuffer());
  };
  const got = await fetchWithTimeout(PACED, consume);
  assert.equal(got.toString(), "payload");
  assert.equal(calls.length, 2, "the 503 was retried, not believed");
});

// Why `issue` exists at all: the waiting happens OUTSIDE the abort timer, so a request
// held back for longer than its own timeout is not thereby a timeout. Without the split
// every backoff longer than timeoutMs would abort the request it was protecting.
test("the waiting is outside the abort timer", async (t) => {
  const { calls } = statusSequence([503]);
  t.after(() => {
    mock.restoreAll();
    setNetworkPacing({ backoffMs: 0 });
  });
  // A backoff far longer than the per-attempt timeout the request is given.
  setNetworkPacing({ backoffMs: 200 });
  const started = Date.now();
  assert.equal(await fetchWithTimeout(PACED, statusOrThrow, 30), 200);
  assert.ok(Date.now() - started >= 180, "the wait happened");
  assert.equal(calls.length, 2, "and did not abort the request it preceded");
});

// ---- every outcome that is not an answer ----

// A status other than 2xx or 404 answers a different question than the one asked - read
// as "not there", it is how a library goes unaudited.
test("a status other than a 2xx or 404 is no answer", async (t) => {
  for (const status of [400, 410, 451]) {
    mock.method(globalThis, "fetch", async () => ({
      ok: false,
      status,
      headers: { get: () => null },
    }));
    await assert.rejects(
      () => fetchWithTimeout(PACED, statusOrThrow),
      (err) =>
        err instanceof NoAnswerError && err.message.includes(`HTTP ${status}`)
    );
    mock.restoreAll();
  }
  t.after(() => mock.restoreAll());
});

// A real server, so fetch's own failures arrive in their own shapes: a body that breaks
// off after the headers, and a redirect that never ends.
test("a body that breaks off, or a redirect loop, is no answer", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"type":"directory","files":[');
    req.socket.destroy();
  });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    for (const route of ["reset", "loop"]) {
      await assert.rejects(
        () =>
          fetchWithTimeout(`http://127.0.0.1:${port}/${route}`, (r) =>
            r.json()
          ),
        (err) => err instanceof NoAnswerError,
        route
      );
    }
  } finally {
    server.close();
  }
});

// When the control point fails too, but short of proving the network gone, the report
// names the request that failed - not the control point it was measured against.
test("a probe that fails short of no-network reports the original request", async (t) => {
  mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === CONTROL) {
      throw connectionFailure("ECONNREFUSED");
    }
    throw connectionFailure("ENOTFOUND");
  });
  t.after(() => mock.restoreAll());
  await assert.rejects(
    () => fetchWithTimeout(OTHER, read),
    (err) =>
      err instanceof NoAnswerError &&
      err.message.includes("cdn.example.com") &&
      !err.message.includes("schemas.example.com")
  );
});

// A review that ends on a refusal says when the host will answer again, where it said:
// api.github.com names the reset of its hourly limit instead of a Retry-After.
test("a refusal that ends the review names the host's rate-limit reset", async (t) => {
  const reset = Math.floor(Date.UTC(2026, 9, 5, 14, 5) / 1000);
  mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 403,
    headers: {
      get: (h) => (h === "x-ratelimit-reset" ? String(reset) : null),
    },
  }));
  t.after(() => mock.restoreAll());
  await assert.rejects(
    () => fetchWithTimeout(PACED, statusOrThrow),
    (err) =>
      err instanceof NoAnswerError &&
      err.message.includes("HTTP 403") &&
      err.message.includes("rate limit resets at 2026-10-05T14:05:00.000Z")
  );
});
