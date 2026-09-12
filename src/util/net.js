// One place to fetch under a hard timeout, for the MANDATORY setup downloads (the
// schema, the allowed-experiments list, the library-hash DB). A bare fetch() with no
// timeout hangs the whole review on a half-open connection, silently and forever;
// these inputs are required, so a stalled fetch must fail loud (a throw that main()
// turns into exit 2), not hang.
//
// The timeout covers the WHOLE operation - the connection AND the body read - because
// `consume` runs while the abort signal is still armed. A timeout that only guarded
// the headers (the shape vendor/verify.js uses for its small JSON) would still hang on
// a body that never arrives.
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
// Belongs here: the abort-timeout wrapper and that decision. Does NOT belong here:
// what is fetched or where it is cached (-> src/util/download.js,
// src/lib/library-hashes.js), nor exiting - this throws NetworkGoneError and main()
// turns it into an exit like any other setup failure.

import { CONTROL_TIMEOUT_MS, SETUP_FETCH_TIMEOUT_MS } from "../config.js";

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

/**
 * Fetch `url` and consume the response, all under one abort timeout. On timeout the
 * connection/body is aborted and a clear error is thrown; a non-timeout failure (a
 * network error, or whatever `consume` throws on a bad status) propagates unchanged.
 * @template T
 * @param {string} url
 * @param {(res: Response) => Promise<T>} consume  Reads the body, or throws on a
 *   non-ok status with the caller's own wording. Runs while the timeout is armed.
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
    await fetchWithTimeout(controlUrl, async () => null, CONTROL_TIMEOUT_MS);
  } catch (err) {
    // The probe took the clause above, so the network is gone - but report it
    // against the request that revealed it, not against the control point.
    throw err instanceof NetworkGoneError
      ? new NetworkGoneError(url, true)
      : err;
  }
}
