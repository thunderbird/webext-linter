// The check-routing primitives: routeCtx (which artifact ctx a check RUNS on, by its
// `input`) and ctxForRule (which corpus a rule's OUTPUT is labelled against). Routing is
// total and explicit - `source` is a first-class sibling, there is no default artifact to
// fall through to, and a declared input with no sibling throws.
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
} from "../../src/checks/registry.js";

test("routeCtx routes each input to its own sibling, and throws on a missing one", () => {
  const source = { tag: "source" };
  const xpi = { tag: "xpi" };
  const manifest = { tag: "manifest" };
  // No `build` key - undefined as in an XPI review, where input:build checks are sca-gated out.
  const siblings = { source, xpi, manifest };

  assert.equal(routeCtx({ input: "source" }, siblings), source);
  assert.equal(routeCtx({ input: "xpi" }, siblings), xpi); // NOT source - a collapse would land here
  assert.equal(routeCtx({ input: "manifest" }, siblings), manifest);
  // A post-summary recheck consumer declares no input; it routes to the source ctx, where
  // the review-level recheck state lives.
  assert.equal(routeCtx({}, siblings), source);
  // A declared input with no sibling (a stray input:build in XPI mode) throws, rather than
  // silently running on the review target.
  assert.throws(
    () => routeCtx({ input: "build", id: "stray" }, siblings),
    /no ctx for input "build"/
  );
});

test("ctxForRule labels output by the acted-on corpus, the producer's for a recheck consumer", () => {
  const registry = loadRegistry();
  const source = { tag: "source" };
  const xpi = { tag: "xpi" };
  const siblings = { source, xpi };

  // A normal check labels by its own input.
  assert.equal(ctxForRule(registry, "unused-permission", siblings), source); // input: source
  assert.equal(ctxForRule(registry, "bundled-files", siblings), xpi); // input: xpi
  // A recheck CONSUMER labels by its PRODUCER's corpus, not siblings.source: the producer
  // (missing-english-localization) is input:xpi, so the re-judged items are the XPI's.
  assert.equal(
    ctxForRule(registry, "missing-english-localization-recheck", siblings),
    xpi
  );
});
