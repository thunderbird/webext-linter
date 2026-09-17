// Deterministic preflight -> manual review: when the add-on transmits data to a remote
// server THE DEVELOPER CHOSE - fixed in the add-on, not entered by the user - a reviewer
// must confirm the ATN listing carries a privacy policy that discloses the collection.
// The trigger is deterministic, but the policy lives in the ATN listing field rather than
// in the package, so it cannot be verified automatically - hence a manual-review
// escalation rather than a finding.
//
// Overt transmissions, whether or not the host can be read. A destination assembled at
// run time may be built from the developer's own constants, which is still their choice,
// or from something the user typed, which is not - and telling those apart needs the code
// read rather than scanned. It is reported anyway and MARKED, rather than dropped: a case
// a reader can dismiss costs a moment, and a site nobody is shown is a blind spot nothing
// closes. Leaving it to the sweep was considered and rejected - the sweep is a fresh read
// with no memory of what this already tripped over, so it trades a certainty for a maybe.
//
// A destination with nothing literal about it at all is classified DYNAMIC rather than
// remote and never reaches this check: that one is the data-exfiltration escalating
// check's (it asks about consent), and a covert disguised channel is already a hard error
// (the disguised-* checks). This is the disclosure angle, and it needs no token. The
// checks run independently and may both fire on one fetch (disclosure vs consent).
//
// Belongs here: finding the overt remote transmissions and escalating one manual-review
// case per site, each naming its host or marked as one this cannot name. Does NOT belong here: the sink scan
// (-> src/parse/network-sinks.js, aggregated by src/lib/outbound-sinks.js), the
// deterministic->manual routing (-> src/checks/registry.js + escalation.js), and
// the authored instructions (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import { getOutboundSinks } from "../../lib/outbound-sinks.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../escalation.js").Escalation} Escalation */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations: Escalation[]}}
   */
  run(ctx) {
    const escalations = [];
    const seen = new Set();
    for (const sink of getOutboundSinks(ctx)) {
      if (!sink.channel.overt || !sink.destClass.remote) {
        continue;
      }
      ctx.note?.(
        sink.file,
        { line: sink.line, column: sink.column },
        `transmits to ${sink.host ?? "a remote server"}`,
        VERDICT.UNSURE
      );
      // EVERY overt remote transmission is a case, including one whose host could not be
      // read. Such a destination may be built from the developer's own constants, which
      // is their choice, or from something the user typed, which is not - and this scan
      // cannot tell those apart. It is reported anyway: a case a reader can dismiss costs
      // a moment, and a site nobody is shown is a blind spot nothing closes. Dropping it
      // also made the case depend on unrelated state - reported when it stood alone,
      // invisible beside a host that resolved - which is not a rule anyone would write.
      //
      // The `hint` says on its own line that this one is unverified, so the entry's
      // question, which reads as being about the developer's servers, does not claim it.
      const host = sink.host ?? "a remote server";
      // One case per SITE, not per host: every site carries its own locus and its own
      // verdict, and the entry still reads one line per host because the registry
      // declares `collapse: subject` (src/report/order.js).
      //
      // Deduped on the three things that make a case distinct: two channels can share a
      // site, and the reviewer answers the same question about them once.
      const key = `${sink.file}:${sink.line}:${host}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      // manualReview: the privacy policy lives in the ATN listing field, not the
      // package, so reading the code cannot settle this - a person must look it up.
      escalations.push({
        item: host,
        file: sink.file,
        loc: { line: sink.line, column: sink.column },
        ...(sink.host ? {} : { hint: "host assembled at run time" }),
      });
    }
    return { findings: [], escalations };
  },
};
