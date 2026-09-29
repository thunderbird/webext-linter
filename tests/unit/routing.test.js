// The check-routing primitive routeCtx: which artifact ctx a check RUNS on, by its
// `input`. Routing is total and explicit - `source` is a first-class sibling, there
// is no default artifact to fall through to, and a declared input with no sibling
// throws.
//
// These use DISTINCT sibling objects on purpose: the rest of the suite hands runChecks a
// single-artifact siblings map (every input aliases one ctx), so a routing collapse to
// siblings.source would pass there. Only distinct siblings catch it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  routeCtx,
  ctxForRule,
  loadRegistry,
  modeEligible,
} from "../../src/checks/registry.js";
import { perArtifact } from "../../src/checks/each-artifact.js";

test("routeCtx routes each input to its own sibling, and throws on a missing one", () => {
  const source = { tag: "source" };
  const xpi = { tag: "xpi" };
  const all = { tag: "all" };
  // No `sca` key - undefined as in an XPI review, where input:sca checks are mode-gated
  // out. `all` IS here: it names whatever the review holds, so it has a sibling in both
  // modes, and in this one it carries the XPI alone.
  const siblings = { source, xpi, all };

  assert.equal(routeCtx({ input: "source" }, siblings), source);
  assert.equal(routeCtx({ input: "xpi" }, siblings), xpi); // NOT source - a collapse would land here
  assert.equal(routeCtx({ input: "all" }, siblings), all);
  // A check with no declared input falls to the source ctx. loadChecks requires an
  // input on every check, so this is the floor, not a routing rule any check uses.
  assert.equal(routeCtx({}, siblings), source);
  // A declared input with no sibling (a stray input:sca in XPI mode) throws, rather than
  // silently running on the review target.
  assert.throws(
    () => routeCtx({ input: "sca", id: "stray" }, siblings),
    /no ctx for input "sca"/
  );
});

test("input:all is not mode-gated, so it runs in an XPI review too", () => {
  // `sca` names an artifact only a source review has, so the route IS the mode gate.
  // `all` names whatever the review holds, which every review holds something of - so it
  // pins no mode, and a check on it decides for itself whether one artifact is enough.
  assert.equal(modeEligible({ input: "sca" }, true), true);
  assert.equal(modeEligible({ input: "sca" }, false), false);
  assert.equal(modeEligible({ input: "all" }, true), true);
  assert.equal(modeEligible({ input: "all" }, false), true);
});

// Recovering a check's ctx after the fact. `inputFor` answers "which sibling did
// this check run on", which the route says by definition - it is NOT how a finding is
// labelled. That is the artifact the finding carries, stamped from the holder that minted
// its locus, so the two cannot be made to disagree by editing one of them.
test("inputFor recovers the sibling a check ran on", () => {
  const registry = loadRegistry();
  const xpi = { tag: "xpi" };
  const siblings = {
    source: { tag: "source" },
    xpi,
    sca: { tag: "sca" },
    all: { tag: "all" },
  };
  assert.equal(registry.inputFor("unused-files"), "xpi");
  assert.equal(registry.inputFor("sca-xpi-declares-vendoring"), "all");
  assert.equal(ctxForRule(registry, "unused-files", siblings), xpi);
});

// The wrap and the registry entry are one decision in two files, so the failure when they
// disagree has to name both halves. Only the `all` route names the artifacts; left to
// itself the body would iterate nothing on any other route and report a clean review.
test("a perArtifact body routed anywhere but `all` fails by name", () => {
  const wrapped = perArtifact(() => ({ findings: [] }));
  assert.throws(
    () => wrapped({ jsSources: [] }, { id: "some-check", input: "source" }),
    /some-check is wrapped in perArtifact but was routed to "source"/
  );
  // And it runs, unremarkably, when the route does name them - over both sides, and over
  // one where a review has one.
  const ran = [];
  const counting = perArtifact((one) => {
    ran.push(one.tag);
    return { findings: [] };
  });
  assert.deepEqual(counting({ xpi: { tag: "x" }, sca: { tag: "s" } }, {}), {
    findings: [],
    escalations: [],
  });
  assert.deepEqual(ran, ["x", "s"]);
  ran.length = 0;
  counting({ xpi: { tag: "x" }, sca: null }, {});
  assert.deepEqual(ran, ["x"], "an XPI review has one artifact, not one twice");
});
