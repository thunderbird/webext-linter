// Running one check's question over every artifact a review has. A check on `input: all`
// is handed the per-artifact ctxs as `ctx.xpi` and `ctx.sca` (src/checks/context.js
// buildAllCtx), and `perArtifact` asks each of them the same thing, concatenating what
// comes back. A check with something cross-artifact to say does not use this at all: it
// writes its own run(ctx) and reads the two by name.
//
// Why a wrapper for the ones that do not: the analyses a sink check reads
// (nonAuthoredJs, getOutboundSinks, buildReachability, getEvalScan) all take a
// single-artifact ctx and memoize against it, and a check's loci come from that ctx's own
// `artifact.at`. So a body written for one artifact is already the per-artifact body, and
// wrapping it leaves it untouched - which is what keeps "ask the shipped XPI too" a routing
// decision rather than a rewrite of every check that makes it.
//
// Belongs here: the fan-out and the note binding it needs. Does NOT belong here: deciding
// WHICH checks fan out (the registry `input`), what a check does when a review has only one
// artifact (the check - a comparison returns early, a scan just scans the one), or how a
// finding says which artifact it is in (the locus, minted by that ctx's artifact).

import { wiringError } from "../lib/errors.js";

/** @typedef {import("./registry.js").RunContext} RunContext */
/** @typedef {import("./registry.js").LoadedCheck} LoadedCheck */

/**
 * Turn a body written for ONE artifact into a check that asks every artifact the review
 * has. The findings and escalations of each come back in one list, each carrying the locus
 * its own artifact minted, so the report says which side every case is in.
 *
 * @param {(ctx: RunContext, check: LoadedCheck) => {findings?: object[], escalations?: object[]}} fn
 *   The per-artifact body, unchanged from the one-artifact shape. Synchronous: a promise
 *   would be read as an empty result, so one is refused.
 * @returns {(ctx: RunContext, check: LoadedCheck) => {findings: object[], escalations: object[]}}
 */
export function perArtifact(fn) {
  return (ctx, check) => {
    if (!ctx.xpi) {
      // Only the `all` route names the artifacts, so a wrapped body on any other route
      // reaches here. Left to itself it would iterate nothing and report a clean review,
      // with nothing saying which half of the pairing is wrong - the wrap and the registry
      // entry have to move together.
      throw wiringError(
        `${check?.id ?? "a check"} is wrapped in perArtifact but was routed to ` +
          `"${check?.input ?? "?"}" - only \`input: all\` names ctx.xpi / ctx.sca`
      );
    }
    const findings = [];
    const escalations = [];
    for (const one of [ctx.xpi, ctx.sca].filter(Boolean)) {
      // The feed note carries the id of the check that is running, and runChecks binds it
      // to the ROUTED ctx only - which here is the `all` ctx, not these. Without this the
      // per-artifact ctxs would carry whatever note a previously routed check left on them,
      // filing this check's verdicts under that one. Assigned rather than projected onto a
      // copy: buildReachability memoizes in a WeakMap keyed on the ctx OBJECT, so a fresh
      // object per check would recompute the reachability graph every time.
      one.note = ctx.note;
      const out = fn(one, check) ?? {};
      if (typeof out.then === "function") {
        throw wiringError(
          `${check?.id ?? "a check"} wraps an async body in perArtifact, which reads ` +
            "results synchronously"
        );
      }
      findings.push(...(out.findings ?? []));
      escalations.push(...(out.escalations ?? []));
    }
    // Both lanes, always. The orchestrator reads `result?.escalations ?? []`, so an absent
    // lane and an empty one are the same to it - but a wrapped body that returns the key
    // on every path should not start omitting it just because this artifact found nothing,
    // and a caller comparing the two shapes would see a difference the route did not make.
    return { findings, escalations };
  };
}
