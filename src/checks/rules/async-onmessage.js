// Async listener passed to a runtime message event's addListener(). Such an event
// answers with what its listener returns, and an async listener always returns a
// Promise - so it claims the response for every message it sees, including the ones
// it meant to decline, and the other listeners never get to answer. It is
// error-prone and must be avoided.
//
// Which events answer that way is read off the schema rather than listed here: an
// event that hands its listener a `sendResponse` and declares a return value is one
// (runtime.onMessage, onMessageExternal, onUserScriptMessage), while one that hands
// over a port and declares no return is not (runtime.onConnect, onConnectExternal).
// So a message event Thunderbird adds later is covered as it arrives, and a chain
// that merely ends in those names resolves to nothing and is dropped.
//
// Belongs here: skipping non-authored code, deciding from the schema which events
// answer with a return value, then narrating each such addListener site (async =
// fail, non-async = pass) and emitting a finding for the async ones.
//
// Does NOT belong here: matching the addListener call shape and the async check (->
// src/parse/async-onmessage.js), the non-authored skip-list (-> src/lib/bundled.js),
// authored wording (-> assets/registry.yaml), severity (-> that registry entry,
// stamped by src/checks/registry.js), and report formatting (-> src/report/format.js).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { asyncOnMessageOf } from "../extract.js";
import { nonAuthoredJs } from "../../lib/bundled.js";

export default {
  run(ctx) {
    const out = [];
    const skip = nonAuthoredJs(ctx); // a library's own listeners are not the dev's
    for (const src of ctx.jsSources) {
      if (skip.has(src.file)) {
        continue;
      }
      const { hits } = asyncOnMessageOf(src);
      for (const hit of hits) {
        if (!answersWithReturnValue(ctx, hit.event)) {
          continue;
        }
        const loc = { line: hit.line, column: hit.column };
        // The event names itself from the API root onwards, so the report reads the
        // same whichever root spelling the add-on reached it through.
        const site = `${hit.event}.addListener`;
        ctx.note?.(
          src.file,
          loc,
          hit.async ? `${site} (async)` : site,
          hit.async ? VERDICT.FAIL : VERDICT.PASS
        );
        if (hit.async) {
          out.push(finding({ file: src.file, loc, item: hit.event }));
        }
      }
    }
    return { findings: out };
  },
};

/**
 * Whether an event answers the sender with what its listener returns - the property
 * that makes an async listener claim every message. Read off the schema: such an
 * event takes a `sendResponse` parameter AND declares a return value, both, so an
 * event that merely returns something for its own reasons does not qualify.
 *
 * The path must BE the event, not merely start with one: resolution matches the
 * longest known prefix and ignores whatever trails it, so `runtime.onMessage.x`
 * resolves to runtime.onMessage. Comparing the resolved event back against the whole
 * path keeps a chain that reaches past an event from being reported under a name
 * the API does not have.
 * @param {import("../registry.js").RunContext} ctx
 * @param {string} event  Dotted event path after the API root.
 * @returns {boolean}
 */
function answersWithReturnValue(ctx, event) {
  const res = ctx.schema.resolveApi(event.split("."));
  return (
    res?.kind === "event" &&
    `${res.namespace}.${res.member}` === event &&
    Boolean(res.def?.returns) &&
    Boolean(res.def?.parameters?.some((p) => p?.name === "sendResponse"))
  );
}
