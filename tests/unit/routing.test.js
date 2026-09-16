// The check-routing primitive routeCtx: which artifact ctx a check RUNS on, by its
// `input`. Routing is
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
  // A check with no declared input falls to the source ctx. loadChecks requires an
  // input on every check, so this is the floor, not a routing rule any check uses.
  assert.equal(routeCtx({}, siblings), source);
  // A declared input with no sibling (a stray input:build in XPI mode) throws, rather than
  // silently running on the review target.
  assert.throws(
    () => routeCtx({ input: "build", id: "stray" }, siblings),
    /no ctx for input "build"/
  );
});
