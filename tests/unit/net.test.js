// Unit tests for the fetch wrapper: the abort timeout, the network rule that tells
// "this load failed" from "there is no network", and the rate gate every outgoing
// request passes through.
//
// Every request is asked through a real cache: the popularity cache for a JSON request, a
// download's cached file for a setup download. Its entry seeds the host's response
// (src/util/net.js, SeededResponse), played by the real transport. A list is one response
// per attempt, the last repeated. A sequence ends on a 200, the answer the caller gets, so
// getting it proves every attempt before it was made, and a sequence that ends short of it
// proves the ones after it were not.
//
// A stalled connection must fail loud (a clear throw), not hang the whole review. The
// timeout covers the body read, not only the headers - so a host that sends headers
// then never sends the body (`{hang: true}`) still aborts.
//
// The network rule has no ambient signal to consult: navigator.onLine does not exist
// in Node and os.networkInterfaces() reports a cable, not a route. So it uses the
// CONTROL POINT - the first host actually reached. That is module state, set once on
// the first response, which makes ORDER matter here: the control-point test runs first,
// while nothing has been reached yet, and the timeout tests follow.
//
// The gate's own state (the per-host interval) is module state too, so the tests that
// assert spacing set the knobs they need and put them back.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  NetworkGoneError,
  NoAnswerError,
  setNetworkPacing,
} from "../../src/util/net.js";
import { setProgress, setFeed } from "../../src/util/log.js";
import {
  NETWORK_RETRIES,
  NETWORK_MAX_WAIT_MS,
  NETWORK_ANNOUNCE_WAIT_MS,
  VENDOR_FETCH_TIMEOUT_MS,
  VENDOR_GITHUB_REPOS_API,
  VENDOR_NPM_DOWNLOADS_API,
} from "../../src/config.js";
import { runCache } from "../../src/util/dest.js";
import { defaultNet } from "../../src/vendor/verify.js";
import {
  popularityKey,
  withPopularityCache,
} from "../../src/vendor/popularity-cache.js";
import {
  cachedExperimentsPath,
  resolveExperimentsZip,
} from "../../src/experiments/fetch.js";
import { seedDownload, seedWorkCache } from "../seed-caches.js";

// Every request here is answered from a seeded response, so there is no budget to respect and no
// refusal to back off from - only real seconds to lose. The tests that are ABOUT the
// gate drive the knobs deliberately, and restore this.
setNetworkPacing({ intervalMs: 0, backoffMs: 0 });

/** @param {string} name @returns {string} npm's downloads URL for a package. */
const npm = (name) => `${VENDOR_NPM_DOWNLOADS_API}${name}`;
/** @param {string} repo @returns {string} GitHub's repository URL. */
const github = (repo) => `${VENDOR_GITHUB_REPOS_API}${repo}`;

const CONTROL = npm("control-point");
const OTHER = github("other/repo");

/**
 * Ask `url` through a popularity cache whose entry for it seeds `response`.
 * @param {string} url
 * @param {object|object[]} [response]  None: the cache holds no entry for `url`.
 * @returns {Promise<object>}
 */
function ask(url, response) {
  const entries =
    response === undefined ? {} : { [popularityKey(url)]: { fake: response } };
  const dir = seedWorkCache({ popularity: entries });
  return withPopularityCache(
    defaultNet,
    runCache(dir, dir).popularity
  ).fetchJson(url);
}

/** The host's 404, handed back by the transport for the caller to read. */
const NOT_FOUND = { status: 404 };

/** The answer a sequence ends on, and what the caller gets from it. */
const ANSWER = { status: 200, json: { downloads: 7 } };
const ANSWERED = { downloads: 7 };

/** @param {unknown} err @returns {boolean} Whether `err` is the host's 404, read as an answer. */
const notFound = (err) =>
  !(err instanceof NoAnswerError) &&
  err.status === 404 &&
  /HTTP 404/.test(err.message);

test("a failing load is told from a failing network by the control point", async () => {
  // 1. The first host reached becomes the control point. Any status proves the route.
  assert.deepEqual(await ask(CONTROL, ANSWER), ANSWERED);

  // 2. A load that cannot connect, while the control point still answers: the network
  //    is fine and that host gave no answer, which the review cannot go on without.
  await assert.rejects(
    () => ask(OTHER, { fail: "ENOTFOUND", probe: { status: 200 } }),
    (err) => {
      assert.ok(err instanceof NoAnswerError);
      assert.ok(err.class.no_answer);
      assert.match(err.message, /api\.github\.com.*ENOTFOUND/);
      return true;
    }
  );

  // 3. ECONNREFUSED means something answered and said no - the route works, and that
  //    host gave no answer.
  await assert.rejects(
    () => ask(OTHER, { fail: "ECONNREFUSED" }),
    NoAnswerError
  );

  // 4. The same failure once the control point has gone too: no network, stop. The
  //    probe comes back through this same rule and takes the clause below.
  await assert.rejects(
    () => ask(OTHER, { fail: "ENOTFOUND", probe: { fail: "ENOTFOUND" } }),
    (err) => {
      assert.ok(err instanceof NetworkGoneError);
      // Reported against the request that revealed it, not the control point.
      assert.match(err.message, /api\.github\.com/);
      return true;
    }
  );

  // 5. And directly on the control point itself.
  await assert.rejects(
    () => ask(CONTROL, { fail: "ENOTFOUND" }),
    NetworkGoneError
  );
});

// A request that reaches no host - a URL that does not parse - is not a host failing to
// answer: the caller reads it like any other failure of its own request. The cache keeps
// no such URL and passes it on.
test("a request that cannot be built is not 'no answer'", async () => {
  await assert.rejects(
    () => ask("not a url"),
    (err) => !(err instanceof NoAnswerError) && err instanceof TypeError
  );
});

// A non-ok response is not a network failure: the host answered. This is the case the
// rule most has to keep its hands off - a 404 from a mistyped release URL is the
// developer's citation being wrong, an ANSWER the caller reads, not the review being
// unable to run.
test("a 404 is an answer the caller reads, never a stop", async () => {
  await assert.rejects(() => ask(npm("gone"), NOT_FOUND), notFound);
});

// Headers sent, body never: the half-open hang the setup fetches must survive.
test("fetchWithTimeout aborts a stalled response: no answer", async () => {
  await assert.rejects(
    () => ask(npm("stalled"), { hang: true }),
    (err) =>
      err instanceof NoAnswerError &&
      err.message.includes(`timed out after ${VENDOR_FETCH_TIMEOUT_MS}ms`)
  );
});

test("fetchWithTimeout returns the consumed body on a fast response", async () => {
  const body = await ask(npm("fast"), {
    status: 200,
    headers: { "content-type": "application/json" },
    body: '{"downloads":1}\n',
  });
  assert.deepEqual(body, { downloads: 1 });
});

// ---- the rate gate ----
// The bug it exists for: api.npmjs.org answers a burst with 429, and a refusal read as an
// answer demoted one add-on's own library, differently on every run. A refusal is not a
// reading: it is waited out, and one that outlasts the retries ends the review. The gate lives HERE, below every
// transport, so no endpoint added later can forget to pass through it.

const PACED = npm("paced");

/**
 * Refusals in order, then the answer.
 * @param {number[]} statuses  Refused in order. Anything after them is the answer.
 * @param {{retryAfter?: string}} [opts]  Sent as Retry-After on every refusal.
 * @returns {object[]}
 */
function refusals(statuses, { retryAfter } = {}) {
  return [
    ...statuses.map((status) => ({
      status,
      ...(retryAfter !== undefined
        ? { headers: { "retry-after": retryAfter } }
        : {}),
    })),
    ANSWER,
  ];
}

/** `count` refusals of `status`. @param {number} count @param {number} [status] */
const times = (count, status = 429) => Array(count).fill(status);

/** Ask PACED, answered by `response`. */
const askPaced = (response) => ask(PACED, response);

/** @param {RegExp|string} status @returns {(err: unknown) => boolean} No answer, for `status`. */
const noAnswer = (status) => (err) =>
  err instanceof NoAnswerError && err.message.includes(`HTTP ${status}`);

// A 429 says nothing about what was asked, so the answer is still out there. If this
// stops holding, a popular library is reported as unknown-origin the moment its host is
// busy - and a minified one is REJECTED for it.
test("a 429 is retried, and the retried answer is the one returned", async () => {
  // The answer is only reached by asking again after the refusal.
  assert.deepEqual(await askPaced(refusals([429])), ANSWERED);
});

// The other shapes a host uses to decline. 403 is how api.github.com says it.
test("403, 408 and 5xx are refusals too, not answers", async () => {
  for (const status of [403, 408, 500, 503]) {
    assert.deepEqual(
      await askPaced(refusals([status])),
      ANSWERED,
      `${status} was retried`
    );
  }
});

// The line that keeps this from becoming "retry everything": npm really does answer 404
// for a package it has no download data for. Retrying it would multiply our load to
// re-learn the same thing.
test("a 404 is an answer, not a refusal, and is never retried", async () => {
  // A second ask would get the answer.
  await assert.rejects(() => askPaced([NOT_FOUND, ANSWER]), notFound);
});

// Nor is a TIMEOUT. A host that declines is worth waiting out; a host that does not
// respond is not, and retrying it would multiply the slowest failure the tool has - the
// mandatory setup downloads wait a minute each, and four of those is a review that looks
// hung rather than one that reports a problem.
test("a timeout is no answer, and it is not retried", async () => {
  // A second ask would get the answer.
  await assert.rejects(
    () => askPaced([{ hang: true }, ANSWER]),
    (err) =>
      err instanceof NoAnswerError &&
      err.message.includes(`timed out after ${VENDOR_FETCH_TIMEOUT_MS}ms`)
  );
});

// Retrying cannot become waiting forever. When the host never relents it has given no
// answer, and the review stops rather than reading the refusal as one.
test("retries are bounded, and a refusal that outlasts them is no answer", async () => {
  // The first ask plus its retries reach an answer placed right after them...
  assert.deepEqual(await askPaced(refusals(times(NETWORK_RETRIES))), ANSWERED);
  // ...and no more: one placed a step further is never reached.
  await assert.rejects(
    () => askPaced(refusals(times(NETWORK_RETRIES + 1))),
    noAnswer(429)
  );
});

// A Retry-After the host actually names is worth more than our guess. npm sends
// "retry-after: 0" with every 429, which names nothing - hence the fallback backoff.
test("a Retry-After that names a delay wins over the backoff", async (t) => {
  t.after(() => {
    setNetworkPacing({ backoffMs: 0 });
  });
  setNetworkPacing({ backoffMs: 60000 }); // would hang the suite if preferred
  assert.deepEqual(
    await askPaced(refusals([429], { retryAfter: "0.01" })),
    ANSWERED
  );
});

// The spacing itself: two requests to one host are held apart, and a different host is
// not made to wait behind it.
test("requests to one host are spaced, and other hosts are not held up", async (t) => {
  t.after(() => {
    setNetworkPacing({ intervalMs: 0 });
  });
  setNetworkPacing({ intervalMs: 60 });
  const started = Date.now();
  assert.deepEqual(await ask(npm("spaced-1"), ANSWER), ANSWERED);
  assert.deepEqual(await ask(npm("spaced-2"), ANSWER), ANSWERED);
  const paced = Date.now() - started;
  assert.ok(paced >= 55, `two asks to one host waited (${paced}ms)`);

  const other = Date.now();
  assert.deepEqual(await ask(github("spaced/one"), ANSWER), ANSWERED);
  assert.ok(
    Date.now() - other < 50,
    "a host asked for the first time does not wait"
  );
});

// TWO THINGS A HOST CAN SAY. Naming a time is an instruction - come back at X - and it
// is obeyed exactly and asked once more. A host that declines again after its own window
// has answered the question, and asking a third time is load it already refused.
test("a named wait is obeyed once, and a second refusal ends it", async () => {
  // A third ask would get the answer.
  await assert.rejects(
    () => askPaced(refusals([429, 429], { retryAfter: "0.01" })),
    noAnswer(429)
  );
});

// ...and when that one ask is answered, the answer is what the caller gets.
test("a named wait that is obeyed gets the answer", async () => {
  assert.deepEqual(
    await askPaced(refusals([429], { retryAfter: "0.01" })),
    ANSWERED
  );
});

// The other case, and the one the ladder exists for: a host that refuses without saying
// when has told us nothing about when either, so the backoff is a guess and gets its
// full count. api.npmjs.org is exactly this - it sends "retry-after: 0" with every 429,
// which names nothing, so it must NOT fall into the obey-once path.
test("a refusal that names no time climbs the full ladder", async () => {
  for (const retryAfter of [undefined, "0"]) {
    const named = `retry-after ${JSON.stringify(retryAfter)} names nothing`;
    assert.deepEqual(
      await askPaced(refusals(times(NETWORK_RETRIES), { retryAfter })),
      ANSWERED,
      named
    );
    await assert.rejects(
      () => askPaced(refusals(times(NETWORK_RETRIES + 1), { retryAfter })),
      noAnswer(429),
      named
    );
  }
});

// RFC 9110 lets a host spell the wait as an HTTP-date instead of seconds, and it picks
// either. Read only as a number, a date coerces to NaN and the host reads as one that
// named nothing - which is the one distinction this whole split rests on.
test("an HTTP-date Retry-After is a named time too", async () => {
  const retryAfter = new Date(Date.now() + 1000).toUTCString();
  assert.deepEqual(await askPaced(refusals([429], { retryAfter })), ANSWERED);
  // Obeyed once, like any named time: a second refusal ends it.
  await assert.rejects(
    () =>
      askPaced(
        refusals([429, 429], {
          retryAfter: new Date(Date.now() + 1000).toUTCString(),
        })
      ),
    noAnswer(429)
  );
});

// A date already past means "now", not a negative wait.
test("an HTTP-date in the past waits no time at all", async () => {
  const retryAfter = new Date(Date.now() - 60000).toUTCString();
  const started = Date.now();
  assert.deepEqual(await askPaced(refusals([429], { retryAfter })), ANSWERED);
  assert.ok(Date.now() - started < 500, "did not wait");
});

// The gate claims its slot BEFORE waiting, so it is a reservation rather than a check.
// Nothing fetches concurrently today; this is what keeps that from being the reason the
// spacing works, because the first Promise.all anyone adds would otherwise un-pace it
// silently, with no test failing.
test("concurrent asks to one host are spaced, not fired together", async (t) => {
  t.after(() => {
    setNetworkPacing({ intervalMs: 0 });
  });
  setNetworkPacing({ intervalMs: 80 });
  const started = Date.now();
  const offsets = await Promise.all(
    [1, 2, 3].map(async (n) => {
      assert.deepEqual(await ask(npm(`together-${n}`), ANSWER), ANSWERED);
      return Date.now() - started;
    })
  );
  offsets.sort((a, b) => a - b);
  assert.ok(offsets[1] >= 70, `second waited its turn (${offsets[1]}ms)`);
  assert.ok(offsets[2] >= 150, `third waited two turns (${offsets[2]}ms)`);
});

// A header that scales past what a number can hold names no delay at all - it is not an
// instruction anyone can act on, so it falls to the guess like an absent one.
test("a Retry-After that overflows names nothing", async () => {
  for (const retryAfter of ["1e308", "1e999"]) {
    // Obeyed once, the second refusal would end it: the full ladder reaches the answer.
    assert.deepEqual(
      await askPaced(refusals(times(NETWORK_RETRIES), { retryAfter })),
      ANSWERED,
      retryAfter
    );
  }
});

// A named wait is obeyed as given, but "as given" has to end somewhere: a limiter naming
// a day is telling us to come back tomorrow, and a review is something a person is
// waiting on. Past the cap the wait is the cap, and the host is still asked once.
test("a named wait longer than the cap waits the cap, and still asks", async (t) => {
  t.after(() => {
    setNetworkPacing({ backoffMs: 0, maxWaitMs: NETWORK_MAX_WAIT_MS });
  });
  // A cap the suite can afford. Without this knob the test would honour the day.
  setNetworkPacing({ backoffMs: 0, maxWaitMs: 20 });
  for (const retryAfter of [
    "86400",
    new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toUTCString(),
  ]) {
    const started = Date.now();
    // The answer is the ask made once more after it.
    assert.deepEqual(
      await askPaced(refusals([429], { retryAfter })),
      ANSWERED,
      retryAfter
    );
    assert.ok(
      Date.now() - started < 1000,
      `waited the cap, not the ${retryAfter} named`
    );
  }
});

// The cap is a ceiling, not the wait: a named time under it is obeyed exactly.
test("a named wait under the cap is obeyed as given", async (t) => {
  t.after(() => {
    setNetworkPacing({ backoffMs: 0, maxWaitMs: NETWORK_MAX_WAIT_MS });
  });
  setNetworkPacing({ backoffMs: 0, maxWaitMs: 60000 });
  const started = Date.now();
  assert.deepEqual(
    await askPaced(refusals([429], { retryAfter: "0.2" })),
    ANSWERED
  );
  const waited = Date.now() - started;
  assert.ok(waited >= 180, `waited the 200ms it named (${waited}ms)`);
});

// ---- what the gate says, and to whom ----
// The announcement is the one thing the gate puts on screen, and the reason a long wait
// is acceptable at all: silence for a minute is indistinguishable from a hang. It is
// also the newest output channel in the tool, so these pin both halves of where it goes.

/**
 * Run one refused request with the feed in a given state, and return what was emitted.
 * @param {{feed: boolean, request: () => Promise<unknown>}} opts  `request` is refused
 *   once and then answered, as its seeded responses say.
 * @returns {Promise<string>}
 */
async function narrationOf({ feed, request }) {
  setProgress(true);
  setFeed(feed);
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
    await request();
  } finally {
    spy.mock.restore();
  }
  return writes.join("");
}

/** A refused popularity request, its refusal naming `retryAfter`. */
const refusedOnce =
  (retryAfter = "3") =>
  () =>
    askPaced(refusals([429], { retryAfter }));

/** Put the gate's narration knobs back. */
function restoreNarration() {
  setFeed(true);
  setProgress(false);
  setNetworkPacing({
    maxWaitMs: NETWORK_MAX_WAIT_MS,
    announceMs: NETWORK_ANNOUNCE_WAIT_MS,
  });
}

test("a long wait says what it is waiting for", async (t) => {
  t.after(restoreNarration);
  setNetworkPacing({ maxWaitMs: 30, announceMs: 10 });
  const said = await narrationOf({ feed: true, request: refusedOnce() });
  // The seconds named are the wait actually taken, not the one the host asked for -
  // here the cap shortened it. What the line has to carry is which host, and why.
  assert.match(said, /Waiting \d+s: api\.npmjs\.org is refusing requests/);
  assert.match(said, /HTTP 429/);
});

// --llm-review switches the feed off because its output IS the document. A line of ours
// inside it is a line the agent was never given, and it reads them as instructions.
test("with the feed off, the gate says nothing at all", async (t) => {
  t.after(restoreNarration);
  setNetworkPacing({ maxWaitMs: 30, announceMs: 10 });
  assert.equal(await narrationOf({ feed: false, request: refusedOnce() }), "");
});

// `err.message` carries words from outside verbatim: a setup download's wording quotes
// the host's reason phrase and the branch it asked for. An escape sequence in one would
// rewrite the terminal above it, erasing the review and leaving whatever was sent in its
// place. A seeded response carries no reason phrase, so the branch carries it here.
test("the host's own words cannot rewrite the terminal", async (t) => {
  t.after(restoreNarration);
  setNetworkPacing({ maxWaitMs: 30, announceMs: 10 });
  const cacheDir = seedWorkCache();
  const branch = "busy\u001b[2J\u001b[1;1H  REVIEW PASSED";
  seedDownload(
    cachedExperimentsPath(cacheDir, branch),
    refusals([429], { retryAfter: "3" })
  );
  const said = await narrationOf({
    feed: true,
    request: () => resolveExperimentsZip({ branch, cacheDir }),
  });
  assert.match(said, /HTTP 429/, "the refusal was narrated");
  assert.ok(!said.includes("\u001b"), "no escape survived");
  assert.match(said, /REVIEW PASSED/, "the text itself is still shown, inert");
});

// A short wait is not a stall, and narrating every one of them would bury the review's
// own output under the gate's.
test("a wait below the threshold is not announced", async (t) => {
  t.after(restoreNarration);
  setNetworkPacing({ maxWaitMs: 30, announceMs: 5000 });
  assert.equal(
    await narrationOf({ feed: true, request: refusedOnce("0.01") }),
    ""
  );
});

// ---- the sequences, and who else the gate now covers ----

// Naming a time is the deal: obeyed once, and then believed. It is believed even when
// the host changes HOW it refuses - the second refusal is still the answer to the ask it
// was given its own window for, whether or not it names a time again. The consequence is
// worth seeing plainly: naming a time REDUCES the tool's total patience, because the
// ladder's remaining rungs are forfeited.
test("a named wait then an unnamed refusal ends it, ladder forfeited", async () => {
  // The ladder would reach the answer.
  await assert.rejects(
    () =>
      askPaced([
        { status: 429, headers: { "retry-after": "0.01" } },
        { status: 429 },
        { status: 429 },
        ANSWER,
      ]),
    noAnswer(429)
  );
});

// A named time is honoured whatever status carried it - 403 is how api.github.com
// declines, and a 5xx names one as readily as a 429.
test("a named wait is obeyed on any refusal, not just a 429", async () => {
  for (const status of [403, 408, 500, 503]) {
    // Obeyed once: a second refusal of the same kind ends it.
    await assert.rejects(
      () => askPaced(refusals([status, status], { retryAfter: "0.01" })),
      noAnswer(status),
      `${status} named a time and was obeyed once`
    );
    assert.deepEqual(
      await askPaced(refusals([status], { retryAfter: "0.01" })),
      ANSWERED,
      `${status} was asked again at the time it named`
    );
  }
});

// The gate covers the SETUP downloads too: they stamp a status on their own wording
// (withHttpStatus), which is what makes a refusal there retryable at all.
test("a refused setup download is retried, keeping its own wording", async () => {
  const cacheDir = seedWorkCache();
  const cached = cachedExperimentsPath(cacheDir, "release");
  // The payload is only reached by asking again after the 503, and is kept as the copy.
  seedDownload(cached, [{ status: 503 }, { status: 200, body: "payload" }]);
  await resolveExperimentsZip({ branch: "release", cacheDir });
  assert.equal(fs.readFileSync(cached, "utf8"), "payload");
  // A 404 after the 503 is reached the same way, and carries the caller's own wording.
  seedDownload(cached, [{ status: 503 }, NOT_FOUND]);
  await assert.rejects(
    () => resolveExperimentsZip({ branch: "release", cacheDir }),
    (err) =>
      !(err instanceof NoAnswerError) &&
      err.status === 404 &&
      /Failed to download the allowed-experiments list "release": HTTP 404/.test(
        err.message
      )
  );
});

// Why `issue` exists at all: the waiting happens OUTSIDE the abort timer, so a request
// held back for longer than its own timeout is not thereby a timeout. Without the split
// every backoff longer than the timeout would abort the request it was protecting.
test("the waiting is outside the abort timer", async (t) => {
  t.after(() => {
    setNetworkPacing({ backoffMs: 0 });
  });
  // A backoff longer than the timeout each attempt is given.
  setNetworkPacing({ backoffMs: VENDOR_FETCH_TIMEOUT_MS + 200 });
  const started = Date.now();
  // The answer is the ask the backoff preceded, not aborted by it.
  assert.deepEqual(await askPaced(refusals([503])), ANSWERED);
  assert.ok(
    Date.now() - started >= VENDOR_FETCH_TIMEOUT_MS,
    "the wait happened"
  );
});

// ---- every outcome that is not an answer ----

// A status other than 2xx or 404 answers a different question than the one asked - read
// as "not there", it is how a library goes unaudited.
test("a status other than a 2xx or 404 is no answer", async () => {
  for (const status of [400, 410, 451]) {
    await assert.rejects(() => askPaced({ status }), noAnswer(status));
  }
});

// A redirect that never ends fails before any response, in fetch's own shape.
test("a redirect loop is no answer", async () => {
  await assert.rejects(
    () => ask(npm("listing"), { fail: "redirect count exceeded" }),
    (err) => err instanceof NoAnswerError
  );
});

// When the control point fails too, but short of proving the network gone, the report
// names the request that failed - not the control point it was measured against.
test("a probe that fails short of no-network reports the original request", async () => {
  await assert.rejects(
    () => ask(OTHER, { fail: "ENOTFOUND", probe: { fail: "ECONNREFUSED" } }),
    (err) =>
      err instanceof NoAnswerError &&
      err.message.includes("api.github.com") &&
      !err.message.includes("api.npmjs.org")
  );
});

// A review that ends on a refusal says when the host will answer again, where it said:
// api.github.com names the reset of its hourly limit instead of a Retry-After.
test("a refusal that ends the review names the host's rate-limit reset", async () => {
  const reset = Math.floor(Date.UTC(2026, 9, 5, 14, 5) / 1000);
  await assert.rejects(
    () =>
      ask(github("limited/repo"), {
        status: 403,
        headers: { "x-ratelimit-reset": String(reset) },
      }),
    (err) =>
      err instanceof NoAnswerError &&
      err.message.includes("HTTP 403") &&
      err.message.includes("rate limit resets at 2026-10-05T14:05:00.000Z")
  );
});
