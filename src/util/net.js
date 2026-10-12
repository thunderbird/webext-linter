// One place to fetch under a hard timeout. A bare fetch() with no timeout hangs the whole
// review on a half-open connection, silently and forever; every answer is one the review
// needs, so a stalled fetch must fail loud (a throw that main() turns into exit 2), not
// hang.
//
// The timeout covers the WHOLE operation - the connection AND the body read - because
// `consume` runs while the abort signal is still armed. A timeout that only guarded
// the headers would still hang on a body that never arrives, so every caller reads
// through `consume` rather than after the fetch resolves.
//
// It also decides, per request, which of three things happened. Every question the
// review asks a host is one it cannot be completed without, so only the first may become a
// value:
//
//   an ANSWER     a 2xx, or a 404 saying there is no such package. Returned, or thrown
//                 carrying its status, for the caller to read.
//   NO ANSWER     any other status, a refusal still standing after the retries, a
//                 timeout, a connection the host did not accept -> NoAnswerError, the
//                 review stops.
//   NO NETWORK    -> NetworkGoneError, the review stops.
//
// Telling the last two apart takes evidence, since nothing in Node can answer it from the
// outside (`navigator.onLine` does not exist here, and os.networkInterfaces() reports a
// cable, not a route). The evidence is the CONTROL POINT, the first host we reached:
//
//   a connection-class failure of the control point -> no network
//   a connection-class failure of anything else     -> fetch the control point, which
//                                                      stops the review if IT fails, and
//                                                      otherwise this host gave no answer
//
// One rule applied to itself, so it terminates: the probe can only recurse one level,
// and that level takes the clause above rather than probing again. That is what tells
// a mistyped hostname (ENOTFOUND, network fine) from being offline (ENOTFOUND for
// everything) - a distinction no error code carries on its own.
//
// It is also where OUR OUTGOING RATE is held down, and for the same reason it is the
// only place that fetches: a host meters us by IP across every stage of the review, and
// no single caller can see what the others have spent. A gate anywhere above this would
// be one each caller had to remember to pass through; here it cannot be bypassed.
//
// The TESTS switch the network off (WEBEXT_LINTER_NO_NETWORK=1, set by tests/offline.js):
// a test is answered by a seeded cache, never by a host. The switch is read once, when this
// module loads, and nothing can turn it back on. While it is on, fetch is never called. Each
// cache asks for a URL in four steps: a real value it keeps is returned; with the network
// off, an entry seeding the host's response (`seeded`, a SeededResponse) is played through
// everything below in place of fetch - the timeout, the retries, the body read, the decision
// above; with the network on, the request goes over the wire and a seeded entry never
// surfaces (seededResponse); and a success, played or live, is kept, while a 404 or a
// failure never is. No cache ever writes a seeded entry. With the network off, a request
// with nothing seeded throws, and with it on, a seeded response handed here is refused.
//
// Belongs here: the abort-timeout wrapper, that decision, and the rate gate (the
// per-host interval, the status a refusal is recognised by, and the two ways a refusal
// is retried - once at the time the host named, or on a guessed backoff when it named
// none). Does NOT belong here: what is fetched or where it is cached (->
// src/util/download.js, src/lib/library-hashes.js), nor exiting - this throws
// NetworkGoneError or NoAnswerError and main() turns it into an exit like any other setup
// failure.

import {
  CONTROL_TIMEOUT_MS,
  SETUP_FETCH_TIMEOUT_MS,
  NETWORK_MIN_INTERVAL_MS,
  NETWORK_RETRIES,
  NETWORK_BACKOFF_MS,
  NETWORK_ANNOUNCE_WAIT_MS,
  NETWORK_MAX_WAIT_MS,
} from "../config.js";
import { ERROR_CLASS } from "../lib/enum.js";
import { LinterError, rethrowIfFatal, wiringError } from "../lib/errors.js";
import { debug, progress } from "./log.js";
import { displayLine } from "./text.js";

/** Whether the tests switched the network off. Read once: no setter, nothing to undo. */
const NO_NETWORK = process.env.WEBEXT_LINTER_NO_NETWORK === "1";

/**
 * Whether the network is switched off - which only the tests do. A cache asks this before it
 * reads a seeded response (`{fake: SeededResponse}`): no cache writes one, so such an entry
 * is a test's stand-in for what the host does, and in a real run it is ignored and the host
 * asked.
 * @returns {boolean}
 */
export function networkSwitchedOff() {
  return NO_NETWORK;
}

/**
 * The response a cache entry seeds for its request (`{fake: SeededResponse}`), or undefined
 * when it seeds none. Read only with the network switched off: no cache writes such an
 * entry, and in a real run one is ignored and the host asked.
 * @param {unknown} entry
 * @returns {SeededResponse|undefined}
 */
export function seededResponse(entry) {
  return NO_NETWORK &&
    entry !== null &&
    typeof entry === "object" &&
    Object.hasOwn(entry, "fake")
    ? entry.fake
    : undefined;
}

/**
 * @typedef {object} SeededResponse  What a host does with one request, as it may come over
 *   the wire, seeded by a test in the cache entry of that request: an HTTP response (its
 *   `status`, any, with `headers` and a text `body` or `json`), a `hang` (headers and never
 *   a body, which runs into the timeout), or a `fail` (a failure before any response, as
 *   fetch names its cause: a code such as "ENOTFOUND", or "redirect count exceeded"). After
 *   a `fail`, `probe` is what the control point gives when it is asked whether the network
 *   is still there.
 * @property {number} [status]
 * @property {Record<string, string>} [headers]
 * @property {string} [body]
 * @property {unknown} [json]
 * @property {boolean} [hang]
 * @property {string} [fail]
 * @property {SeededResponse} [probe]
 */

/**
 * Thrown when the network itself is gone, as opposed to one load failing. Its own
 * type so main() can word the exit for it and no caller mistakes it for a fetch
 * error it should carry on from, and a LinterError so every swallowing catch
 * re-throws it through rethrowIfFatal without naming this class.
 */
export class NetworkGoneError extends LinterError {
  /**
   * @param {string} url  The request that revealed it.
   * @param {boolean} viaControl  Whether the control point was probed and failed
   *   too, rather than the failing request BEING the control point.
   */
  constructor(url, viaControl) {
    super(
      ERROR_CLASS.NETWORK_GONE,
      viaControl
        ? `no network: ${url} could not be reached, and neither could the host this review had already reached. A review cannot run without network access.`
        : `no network: ${url} could not be reached. A review cannot run without network access.`
    );
    this.name = "NetworkGoneError";
  }
}

/**
 * Thrown when one host gave no answer the review could use: it was still refusing after
 * the retries, it did not respond in time, or it did not accept the connection while the
 * network was otherwise fine. Every question asked of a host is one the review cannot be
 * completed without, so this ends the run like NetworkGoneError - a review that went on
 * would read the silence as a value (no advisories, not shipped, not popular). Its own
 * class, because the remedy differs: the network is fine, that host is not.
 */
export class NoAnswerError extends LinterError {
  /**
   * @param {string} url  The request that got no answer.
   * @param {string} reason  Why, in a few words ("HTTP 503", "timed out after 10s").
   */
  constructor(url, reason) {
    super(
      ERROR_CLASS.NO_ANSWER,
      `no answer from ${meteredHost(url)}: ${url} (${reason}). The review cannot be completed without it. Run it again once the host answers.`
    );
    this.name = "NoAnswerError";
  }
}

// Failures that happen BEFORE any response - the only ones that can mean "no
// network". ECONNREFUSED is deliberately absent: something answered, so the network
// works. A timeout is absent for the same reason - a slow or half-open host says nothing
// about the route to the rest of the internet. Both are that host giving no answer.
const NO_RESPONSE_CODES = new Set([
  "ENOTFOUND", // DNS said no such host - offline, OR a hostname that does not exist
  "EAI_AGAIN", // DNS temporary failure
  "ENETUNREACH", // no route to the network
  "EHOSTUNREACH", // no route to the host
  "ENETDOWN",
]);

// The first host we reached. Every later request is measured against it: it is known
// to have worked, and the review could not have got this far otherwise.
let controlUrl = null;

/**
 * Whether a thrown fetch error happened before any response arrived.
 * @param {unknown} err
 * @returns {boolean}
 */
function isConnectionFailure(err) {
  for (let e = err; e; e = e.cause) {
    if (NO_RESPONSE_CODES.has(e.code)) {
      return true;
    }
  }
  return false;
}

// WE PACE OURSELVES, THEY DO NOT PACE US. A host meters a caller by IP, and answers a
// burst by REFUSING. Read as an answer, a refusal is a verdict nobody reached:
// api.npmjs.org showed it, a 429 read as "not widely used" demoting a library differently
// on every run, and an unreachable OSV would read as a clean bill of health for a package
// nobody checked.
//
// So the gate holds each host to an interval and retries a refusal rather than believing
// it, and a refusal that outlasts the retries is no answer (NoAnswerError). Module-level,
// because the rate is OURS in total: the vendor step, the CDN identifier and the dependency
// audit all ask, about different things, and none of them can see what the others have
// spent.
const nextFree = new Map();

// With the network off there is no host to be held to a rate: every request is a seeded
// response, played at once. The tests of the gate set the values they exercise.
let networkIntervalMs = NO_NETWORK ? 0 : NETWORK_MIN_INTERVAL_MS;
let networkBackoffMs = NO_NETWORK ? 0 : NETWORK_BACKOFF_MS;
let networkMaxWaitMs = NETWORK_MAX_WAIT_MS;
let networkAnnounceMs = NETWORK_ANNOUNCE_WAIT_MS;

/**
 * Shorten (or remove) the waiting, for suites that answer these requests from a fixture
 * and must not pay real time for a gate against a host they never reach. Production
 * never calls this: the shipped values are the ones in config.js.
 * `maxWaitMs` is the one a suite cannot do without: the interval and the backoff are
 * OURS to shorten, while an obeyed wait is the HOST's, so a fixture naming a long one
 * would be honoured in real seconds with nothing able to stop it. `announceMs` is the
 * bar the wait has to clear to be narrated, and lowering it is the only way to see that
 * line without paying for the wait that normally earns it.
 * @param {{intervalMs?: number, backoffMs?: number, maxWaitMs?: number,
 *   announceMs?: number}} pacing
 * @returns {void}
 */
export function setNetworkPacing({
  intervalMs,
  backoffMs,
  maxWaitMs,
  announceMs,
} = {}) {
  if (Number.isFinite(intervalMs)) {
    networkIntervalMs = Math.max(0, intervalMs);
  }
  if (Number.isFinite(backoffMs)) {
    networkBackoffMs = Math.max(0, backoffMs);
  }
  if (Number.isFinite(maxWaitMs)) {
    networkMaxWaitMs = Math.max(0, maxWaitMs);
  }
  if (Number.isFinite(announceMs)) {
    networkAnnounceMs = Math.max(0, announceMs);
  }
}

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return ms > 0
    ? new Promise((done) => setTimeout(done, ms))
    : Promise.resolve();
}

/** @param {string} url @returns {string} The host to meter, or the whole URL. */
function meteredHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (err) {
    rethrowIfFatal(err);
    return String(url);
  }
}

/**
 * Stamp a response's status onto an error, so a refusal can be told from an answer
 * without re-reading the response.
 *
 * Separate from httpError because a caller's own wording is often the useful part - the
 * schema download's 404 says which branch is missing - and that message should not be thrown away
 * to gain a status.
 * @param {Error} err  The error to stamp, returned. @param {Response} res
 * @returns {Error}
 */
export function withHttpStatus(err, res) {
  err.status = res.status;
  const after = retryAfterMs(res.headers?.get("retry-after"));
  if (after !== null) {
    err.retryAfterMs = after;
  }
  // When a host's rate limit resets, if it says (api.github.com does, in epoch seconds,
  // instead of a Retry-After). Not waited for - it is what a refusal that ends the review
  // tells the reviewer, so they know when a re-run can succeed.
  const reset = Number(res.headers?.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    err.rateLimitResetMs = reset * 1000;
  }
  return err;
}

/**
 * Why a refusal that outlasted the retries ended the review: its status, and when the host
 * said it would answer again, where it said.
 * @param {{status: number, retryAfterMs?: number, rateLimitResetMs?: number}} err
 * @returns {string}
 */
function refusalReason(err) {
  const parts = [`HTTP ${err.status}`];
  if (err.rateLimitResetMs !== undefined) {
    parts.push(
      `its rate limit resets at ${new Date(err.rateLimitResetMs).toISOString()}`
    );
  }
  if (err.retryAfterMs !== undefined) {
    parts.push(`it asked to wait ${Math.ceil(err.retryAfterMs / 1000)}s`);
  }
  return parts.join(", ");
}

/**
 * The delay a Retry-After header names, in ms, or null when it names none.
 *
 * RFC 9110 allows two spellings and a host picks either, so both are read: delta-seconds,
 * and an HTTP-date, which is turned into a delay from now and floored at zero (a date
 * already past means "now", not a negative wait).
 *
 * "0" names nothing, and that matters: api.npmjs.org sends it with every 429, so npm
 * lands on the guessing path rather than being asked again immediately. An absent header
 * reads the same way, which is correct - both mean the host did not say when.
 *
 * A date already PAST is not the same thing, though it also comes to zero. That one is an
 * instruction - "you may come back now" - from a host that named a moment and has since
 * passed it, so it is obeyed like any other named time, immediately and once. The
 * difference is not the number; it is that one host said when and the other did not.
 * @param {?string} header  The raw header value, or null.
 * @returns {?number}
 */
function retryAfterMs(header) {
  if (!header) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    const ms = seconds * 1000;
    // Finite seconds can still overflow into Infinity once scaled, and an infinite wait
    // is not a delay a host named - it is a header nobody can act on.
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * The error a non-ok response becomes where the caller has no wording of its own.
 *
 * The status rides on the error (withHttpStatus): fetchWithTimeout reads it to tell a
 * refusal or a 404 from no answer, and a caller to recognise the 404 (src/lib/cdn-lookup.js).
 * @param {Response} res
 * @returns {Error}
 */
export function httpError(res) {
  return withHttpStatus(new Error(`HTTP ${res.status}`), res);
}

/**
 * Whether a failed request was the host REFUSING to answer rather than answering.
 *
 * The distinction is the whole point: 429 (budget spent), 403 (api.github.com says the
 * same thing that way), 408 and any 5xx say nothing about what was asked, so the answer
 * is still out there to be had. A 404 is NOT one of these: npm really does answer 404
 * for a package it has no download data for, and retrying it would multiply our load to
 * re-learn the same thing.
 *
 * Nor is a TIMEOUT. A refusal is a host declining; a timeout is a host not responding,
 * and retrying it multiplies the slowest failure the tool has - the mandatory setup
 * downloads wait a minute each, and four of those is a review that looks hung.
 *
 * Read off `status` alone, which is a requirement on every consume rather than a
 * preference: one that throws without stamping (withHttpStatus) is a refusal nothing
 * here can see, and it will be believed on the first try. All four in src/ stamp.
 * @param {unknown} err
 * @returns {boolean}
 */
function refusedToAnswer(err) {
  const status = Number(err?.status);
  return (
    Number.isFinite(status) &&
    (status === 429 || status === 403 || status === 408 || status >= 500)
  );
}

/**
 * Fetch `url` and consume the response, under one abort timeout, held to this host's
 * interval, and retried while the host is refusing to answer.
 *
 * EVERY request in the tool comes through here, which is the point: the gate is not
 * something a caller opts into, so no endpoint can be added later that forgets it.
 *
 * `rethrowIfFatal` runs first on every failure, so a dead route or a host that never
 * responded stops the review promptly - we retry a refusal, not an absence of network.
 * A refusal still standing after the retries, or any status but a 404, is no answer either
 * (NoAnswerError). A 404 is re-thrown untouched for the caller to read (no such package),
 * as is a failure with no status (the caller's verdict on bytes that arrived).
 * @template T
 * @param {string} url
 * @param {(res: Response) => Promise<T>} consume  Reads the body, or throws on a
 *   non-ok status with the caller's own wording and the status on it (withHttpStatus).
 *   Runs while the timeout is armed. A retry runs it again, against a fresh response.
 * @param {number} [timeoutMs]
 * @param {RequestInit} [init]  Extra fetch options (method/headers/body). The abort
 *   signal and redirect handling are set here and cannot be overridden.
 * @param {SeededResponse|SeededResponse[]} [seeded]  The response a test's cache seeded
 *   for this request, played in place of fetch: one per attempt when a list, its last
 *   repeated.
 * @returns {Promise<T>}
 */
export async function fetchWithTimeout(
  url,
  consume,
  timeoutMs = SETUP_FETCH_TIMEOUT_MS,
  init,
  seeded
) {
  const host = meteredHost(url);
  // Set once the host has named a time and been asked again at it. That ask was the
  // deal: refused after its own window, the host has now declined twice and is believed.
  let obeyed = false;
  for (let attempt = 0; ; attempt++) {
    // The slot is CLAIMED before the wait, not stamped after it. Reading the last time
    // and writing it back either side of an await is a check, not a reservation: two
    // callers reaching it together would both see the same gap and both go. Nothing
    // fetches concurrently today, and this is what keeps that from being the reason
    // the gate works.
    //
    // Start-to-start, so a slow response has already spent its gap and costs nothing
    // extra, and a host asked for the first time never waits.
    const slot = Math.max(Date.now(), nextFree.get(host) ?? 0);
    nextFree.set(host, slot + networkIntervalMs);
    await delay(slot - Date.now());
    try {
      return await issue(
        url,
        consume,
        timeoutMs,
        init,
        Array.isArray(seeded)
          ? seeded[Math.min(attempt, seeded.length - 1)]
          : seeded
      );
    } catch (err) {
      rethrowIfFatal(err);
      if (!refusedToAnswer(err)) {
        // A status is an answer only when it is one a caller can read: a 2xx, or a 404
        // saying there is no such thing. Any other (a 400, a 410, a 451, a 304 nobody
        // asked for) answers a different question than the one asked, and reading it
        // as "not there" is how a library goes unaudited. A failure with no status is
        // the caller's own verdict on bytes that arrived (a size cap), and stays its own.
        if (err?.status !== undefined && err.status !== 404) {
          throw new NoAnswerError(url, `HTTP ${err.status}`);
        }
        throw err;
      }
      if (obeyed) {
        throw new NoAnswerError(url, refusalReason(err));
      }
      // TWO THINGS A HOST CAN SAY, and they are not the same thing.
      //
      // Naming a time is an instruction: come back at X. It is obeyed exactly and asked
      // once more, because a host that declines again after its own window has answered
      // the question. The doubling backoff is the other case - a GUESS, for a host that
      // refused without saying when, which is what api.npmjs.org does when it sends
      // "retry-after: 0" with every 429. Guessing where we were told would ignore what
      // the host said about when, and asking three more times would ignore that it said
      // no at all.
      const named = err?.retryAfterMs;
      let wait;
      if (named !== undefined) {
        obeyed = true;
        // Obeyed as given, up to NETWORK_MAX_WAIT_MS: a limiter naming a day is telling
        // us to come back tomorrow, and a review is something a person is waiting on.
        wait = Math.min(named, networkMaxWaitMs);
      } else {
        if (attempt >= NETWORK_RETRIES) {
          throw new NoAnswerError(url, refusalReason(err));
        }
        wait = networkBackoffMs * 2 ** attempt;
      }
      debug(`${url} refused (${err.message}) - retrying in ${wait}ms`);
      // A wait long enough to look like a stall says what it is waiting for - whichever
      // path set it. The guessed ladder reaches the threshold too, on its second rung and
      // after, so a host refusing without saying when is narrated as well as one that
      // named a minute. Through the FEED, not the always-on channel: --llm-review switches the feed off because its
      // output IS the document, and a line of ours inside that document is a line the
      // agent was not given. And through displayLine, because `err.message` carries the
      // HOST's own words - a reason phrase reaches us verbatim, and an escape sequence in
      // one would rewrite the terminal above it.
      if (wait >= networkAnnounceMs) {
        progress(
          displayLine(
            `Waiting ${Math.round(wait / 1000)}s: ${host} is refusing requests (${err.message}).`
          )
        );
      }
      await delay(wait);
    }
  }
}

/**
 * One attempt: the fetch and its body read, under the abort timeout. Split out so the
 * waiting above happens OUTSIDE the timer - the timeout covers the request, never the
 * time spent holding it back.
 * @template T
 * @param {string} url @param {(res: Response) => Promise<T>} consume
 * @param {number} timeoutMs @param {RequestInit} [init]
 * @param {SeededResponse} [seeded]  Played in place of fetch (fetchWithTimeout).
 * @returns {Promise<T>}
 */
async function issue(url, consume, timeoutMs, init, seeded) {
  // Before the timer and outside the try below, so it is never read as a host that gave no
  // answer. A wiring error, the class no catch absorbs: a caller that tolerates one failed
  // request (the vendor verification does) would otherwise swallow it, and the test would pass on a
  // request it was never allowed to make. A URL that does not parse is the caller's own
  // failure, as fetch reports it, before either.
  if (seeded !== undefined && !NO_NETWORK) {
    throw wiringError(`a seeded response outside a test: ${url}`);
  }
  if (
    seeded !== undefined &&
    seeded.fail === undefined &&
    !seeded.hang &&
    !Number.isInteger(seeded.status)
  ) {
    throw wiringError(`a seeded response names no status: ${url}`);
  }
  if (seeded === undefined && NO_NETWORK) {
    new URL(url);
    throw wiringError(`network request in a test: ${url}`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    try {
      res =
        seeded === undefined
          ? await fetch(url, {
              ...init,
              signal: ctrl.signal,
              redirect: "follow",
            })
          : replay(url, seeded, ctrl.signal);
    } catch (err) {
      // No response. Either the network is gone (assertNetwork stops the review with
      // that), or this host gave no answer: it refused the connection, failed TLS, or
      // sent us round a redirect loop. Only a URL that does not parse reached no host,
      // and stays the caller's to read.
      if (ctrl.signal.aborted) {
        throw timedOut(url, timeoutMs);
      }
      if (isConnectionFailure(err)) {
        await assertNetwork(url, failureReason(err), seeded?.probe);
      }
      if (hasCode(err, "ERR_INVALID_URL")) {
        throw err;
      }
      throw new NoAnswerError(url, failureReason(err));
    }
    // Reached a host: remember the first one as the control point. Any status will
    // do - what it proves is the route, not the resource.
    controlUrl ??= url;
    try {
      return await consume(res);
    } catch (err) {
      // The body is read under the same timer, so a host that sent headers and then
      // stalled gave no answer either; nor did one whose body broke off or would not
      // decode, which fetch reports as a TypeError. Anything else consume throws is its
      // reading of the response - a status, or a verdict on bytes that did arrive - and
      // stays the caller's.
      if (ctrl.signal.aborted) {
        throw timedOut(url, timeoutMs);
      }
      if (err instanceof TypeError && err.status === undefined) {
        throw new NoAnswerError(url, failureReason(err));
      }
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What fetch would have given for `url`, had the host done what `seeded` says: the same
 * parse of the URL, the same failure before a response, a Response whose body a hang never
 * delivers until the abort, or a Response with the status, headers and body the host gave.
 * @param {string} url
 * @param {SeededResponse} seeded
 * @param {AbortSignal} signal
 * @returns {Response}
 */
function replay(url, seeded, signal) {
  new URL(url);
  if (seeded.fail !== undefined) {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error(seeded.fail), { code: seeded.fail }),
    });
  }
  const res = seeded.hang
    ? new Response(
        new ReadableStream({
          start(stream) {
            signal.addEventListener("abort", () => stream.error(signal.reason));
          },
        })
      )
    : new Response(
        seeded.json !== undefined
          ? JSON.stringify(seeded.json)
          : (seeded.body ?? ""),
        { status: seeded.status, headers: seeded.headers }
      );
  // A Response made here carries no URL, where fetch's carries the one it answered, and
  // every reader that names the request names it by `res.url`.
  Object.defineProperty(res, "url", { value: url });
  return res;
}

/** @param {string} url @param {number} timeoutMs @returns {NoAnswerError} */
function timedOut(url, timeoutMs) {
  return new NoAnswerError(url, `timed out after ${timeoutMs}ms`);
}

/** @param {unknown} err @param {string} code @returns {boolean} */
function hasCode(err, code) {
  for (let e = err; e; e = e.cause) {
    if (e.code === code) {
      return true;
    }
  }
  return false;
}

/**
 * The few words saying why a fetch failed: the deepest error code in the chain
 * (ECONNREFUSED, ERR_SSL_WRONG_VERSION_NUMBER, UND_ERR_SOCKET), else the deepest message
 * ("redirect count exceeded").
 * @param {unknown} err @returns {string}
 */
function failureReason(err) {
  let reason = err instanceof Error ? err.message : String(err);
  for (let e = err; e; e = e.cause) {
    if (typeof e.code === "string") {
      reason = e.code;
    } else if (e !== err && typeof e.message === "string" && e.message) {
      reason = e.message;
    }
  }
  return reason;
}

/**
 * A request failed before any response. Decide whether the network is gone, and
 * throw NetworkGoneError if it is; return quietly when only that one load failed. A probe
 * that fails short of proving the network gone (refused, timed out) still says nothing
 * good about the request, which is reported as having had no answer - against its own
 * URL, not the control point's.
 * @param {string} url  The request that failed.
 * @param {string} reason  Why it failed, for that report.
 * @param {SeededResponse} [probe]  What the control point gives when asked, in a test.
 * @returns {Promise<void>}
 */
async function assertNetwork(url, reason, probe) {
  // Nothing has ever been reached, so there is no evidence to weigh - and the first
  // request a review makes is one it cannot proceed without.
  if (controlUrl === null || url === controlUrl) {
    throw new NetworkGoneError(url, false);
  }
  // Ask the host we know we reached. That call comes back through this same rule,
  // where the clause above stops the review if it too is unreachable - so this
  // returns only when the network is fine and it was this load that failed.
  try {
    // `issue`, not the paced entry point: this runs from inside a failure to decide
    // whether the network is gone, and waiting or retrying would delay the one answer
    // that has to arrive fast. Reaching the primitive directly rather than asking the
    // gate to stand aside is what keeps the gate something no CALLER can opt out of.
    await issue(
      controlUrl,
      async () => null,
      CONTROL_TIMEOUT_MS,
      undefined,
      probe
    );
  } catch (err) {
    // The probe took the clause above, so the network is gone - but report it
    // against the request that revealed it, not against the control point.
    if (err instanceof NetworkGoneError) {
      throw new NetworkGoneError(url, true);
    }
    // A probe a test seeded no response for is a request it was never allowed to make.
    if (err?.class?.wiring) {
      throw err;
    }
    throw new NoAnswerError(url, reason);
  }
}
