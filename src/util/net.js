// One place to fetch under a hard timeout, for the MANDATORY setup downloads (the
// schema, the allowed-experiments list, the library-hash DB). A bare fetch() with no
// timeout hangs the whole review on a half-open connection, silently and forever;
// these inputs are required, so a stalled fetch must fail loud (a throw that main()
// turns into exit 2), not hang.
//
// The timeout covers the WHOLE operation - the connection AND the body read - because
// `consume` runs while the abort signal is still armed. A timeout that only guarded
// the headers would still hang on a body that never arrives, so every caller reads
// through `consume` rather than after the fetch resolves.
//
// It also decides, per request, whether a failure means "this load failed" or "there
// is no network". Nothing in Node can answer that from the outside: `navigator.onLine`
// does not exist here, and os.networkInterfaces() reports a cable, not a route. So the
// answer comes from evidence - the CONTROL POINT, the first host we reached. Reaching
// any later request proves that one worked, since a review cannot start without it.
//
//   a response, any status | ECONNREFUSED | a timeout  -> the load failed
//   a connection-class failure of the control point    -> no network, stop
//   a connection-class failure of anything else        -> fetch the control point,
//                                                         which stops if IT fails
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
// Belongs here: the abort-timeout wrapper, that decision, and the rate gate (the
// per-host interval, the status a refusal is recognised by, and the two ways a refusal
// is retried - once at the time the host named, or on a guessed backoff when it named
// none). Does NOT belong here: what is fetched or where it is cached (->
// src/util/download.js, src/lib/library-hashes.js), nor exiting - this throws
// NetworkGoneError and main() turns it into an exit like any other setup failure.

import {
  CONTROL_TIMEOUT_MS,
  SETUP_FETCH_TIMEOUT_MS,
  NETWORK_MIN_INTERVAL_MS,
  NETWORK_RETRIES,
  NETWORK_BACKOFF_MS,
  NETWORK_ANNOUNCE_WAIT_MS,
  NETWORK_MAX_WAIT_MS,
} from "../config.js";
import { debug, progress } from "./log.js";
import { displayLine } from "./text.js";

/**
 * Thrown when the network itself is gone, as opposed to one load failing. Its own
 * type so main() can word the exit for it and no caller mistakes it for a fetch
 * error it should carry on from.
 */
export class NetworkGoneError extends Error {
  /**
   * @param {string} url  The request that revealed it.
   * @param {boolean} viaControl  Whether the control point was probed and failed
   *   too, rather than the failing request BEING the control point.
   */
  constructor(url, viaControl) {
    super(
      viaControl
        ? `no network: ${url} could not be reached, and neither could the host this review had already reached. A review cannot run without network access.`
        : `no network: ${url} could not be reached. A review cannot run without network access.`
    );
    this.name = "NetworkGoneError";
  }
}

/**
 * Re-throw when the network itself is gone, and return otherwise. Called at the top of
 * every catch that swallows a fetch failure into a benign value ("not popular", "no CDN
 * match", "unfetchable"): those fallbacks are right for ONE load failing and wrong for a
 * dead route, where they would silently reclassify a popular library as the developer's
 * own code. The distinction is not the caller's to make - assertNetwork already made it
 * with a control-point probe - so each swallow site only has to not eat the answer.
 *
 * A 404 or a timeout is NOT this: something answered, and the benign fallback stands.
 * @param {unknown} err  The caught error.
 * @returns {void}
 */
export function rethrowIfNetworkGone(err) {
  if (err instanceof NetworkGoneError) {
    throw err;
  }
}

// Failures that happen BEFORE any response - the only ones that can mean "no
// network". ECONNREFUSED is deliberately absent: something answered, so the network
// works. A timeout is absent for the same reason it is not fatal - a slow or
// half-open host says nothing about the route to the rest of the internet.
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
// burst by REFUSING - which arrives here as an exception that every swallow site in the
// tool reads as an answer. api.npmjs.org showed what that costs: a 429 read as "not
// widely used" demoted a library and rejected its minified files, differently on every
// run. The same shape waits at every other endpoint - an unreachable OSV records no
// advisories, which is a clean bill of health for a package nobody checked.
//
// So the gate holds each host to an interval and retries a refusal rather than believing
// it. Module-level, because the rate is OURS in total: the vendor step, the CDN
// identifier and the dependency audit all ask, about different things, and none of them
// can see what the others have spent.
const nextFree = new Map();

let networkIntervalMs = NETWORK_MIN_INTERVAL_MS;
let networkBackoffMs = NETWORK_BACKOFF_MS;
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
  } catch {
    return String(url);
  }
}

/**
 * Stamp a response's status onto an error, so a refusal can be told from an answer
 * without re-reading the response.
 *
 * Separate from httpError because a caller's own wording is often the useful part - the
 * schema download says which schema failed - and that message should not be thrown away
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
  return err;
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
 * The message shape is load-bearing: the CDN identifier tells a genuine 404 from a
 * transient failure with a regex over it (src/lib/cdn-lookup.js), and an injected test
 * net throws the same shape by hand.
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
 * `rethrowIfNetworkGone` runs first on every failure, so a dead route still stops the
 * review promptly - we retry a refusal, not an absence of network. Anything that is not
 * a refusal is re-thrown untouched on the first try, leaving each caller's existing
 * fallback to mean exactly what it always meant.
 * @template T
 * @param {string} url
 * @param {(res: Response) => Promise<T>} consume  Reads the body, or throws on a
 *   non-ok status with the caller's own wording. Runs while the timeout is armed.
 *   A retry runs it again, against a fresh response.
 * @param {number} [timeoutMs]
 * @param {RequestInit} [init]  Extra fetch options (method/headers/body). The abort
 *   signal and redirect handling are set here and cannot be overridden.
 * @returns {Promise<T>}
 */
export async function fetchWithTimeout(
  url,
  consume,
  timeoutMs = SETUP_FETCH_TIMEOUT_MS,
  init
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
      return await issue(url, consume, timeoutMs, init);
    } catch (err) {
      rethrowIfNetworkGone(err);
      if (obeyed || !refusedToAnswer(err)) {
        throw err;
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
          throw err;
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
 * @returns {Promise<T>}
 */
async function issue(url, consume, timeoutMs, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      redirect: "follow",
    });
    // Reached a host: remember the first one as the control point. Any status will
    // do - what it proves is the route, not the resource.
    controlUrl ??= url;
    return await consume(res);
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
    }
    if (isConnectionFailure(err)) {
      await assertNetwork(url);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A request failed before any response. Decide whether the network is gone, and
 * throw NetworkGoneError if it is; return quietly when only that one load failed.
 * @param {string} url  The request that failed.
 * @returns {Promise<void>}
 */
async function assertNetwork(url) {
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
    await issue(controlUrl, async () => null, CONTROL_TIMEOUT_MS);
  } catch (err) {
    // The probe took the clause above, so the network is gone - but report it
    // against the request that revealed it, not against the control point.
    throw err instanceof NetworkGoneError
      ? new NetworkGoneError(url, true)
      : err;
  }
}
