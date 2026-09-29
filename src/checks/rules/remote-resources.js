// The add-on must bundle everything it loads. This check reports what the DEVELOPER
// ships: a definite remote load - <script>/<link>/<iframe>/media in HTML, @import/url()
// in CSS, import()/importScripts()/module imports, runtime <script> injection, remote
// WASM, or a content_security_policy permitting a remote script source - is a finding.
// A site the scan cannot resolve (a non-literal URL, an inline data:/blob: script
// source) escalates for a reader of the code to settle.
//
// A remote load inside a file whose content matched a published upstream release is a
// DIFFERENT question - it is that release's line, not the developer's - and belongs to
// vendored-remote-resources. Both checks read one shared scan (getRemoteRefs), so the
// walk happens once whichever of them runs.
//
// Belongs here: turning the developer's own sites into findings and the undecidable
// ones into escalations, and narrating both (plus the bundled loads it clears, which are
// on the trail of "what runs"). Does NOT belong here: the scan and its classification
// (-> src/lib/remote-refs.js), the upstream lane (-> vendored-remote-resources.js),
// missing local files (-> bundled-files.js), authored wording (-> assets/registry.yaml),
// severity and the escalation section (-> that registry entry, applied by
// src/checks/registry.js), and report formatting (-> src/report/format.js).

import { VERDICT } from "../../lib/enum.js";
import { getRemoteRefs } from "../../lib/remote-refs.js";
import { dedupe } from "../../lib/util.js";
import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../escalation.js").Escalation} Escalation */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[],
   *   escalations: Escalation[]}}
   */
  run(ctx) {
    const refs = getRemoteRefs(ctx);
    const findings = [];
    for (const site of refs.definite) {
      findings.push(
        finding({ ...ctx.artifact.at(site.file, site.loc), item: site.url })
      );
      ctx.note?.(ctx.artifact.at(site.file, site.loc), site.note, VERDICT.FAIL);
    }
    // A bundled script/frame load - cleared, but narrated: it is on the trail of
    // "what runs".
    for (const site of refs.cleared) {
      ctx.note?.(ctx.artifact.at(site.file, site.loc), site.note, VERDICT.PASS);
    }
    // Each undecidable site carries only its locus: it has no resolvable URL, so the
    // authored wording is generic (no {{item}} slot).
    const escalations = [];
    for (const site of refs.undecidable) {
      escalations.push({ ...ctx.artifact.at(site.file, site.loc) });
      ctx.note?.(
        ctx.artifact.at(site.file, site.loc),
        site.note,
        VERDICT.UNSURE
      );
    }
    // Minted by the manifest, not by this check's route: the CSP was read out of the
    // SHIPPED manifest.json (ctx.manifest), which in a source review is a different
    // artifact from the code this check is routed to. The mint also carries the line,
    // which a hand-written locus here never had.
    const csp = ctx.manifest.locus("content_security_policy");
    for (const host of refs.cspHosts) {
      findings.push(finding({ ...csp, item: host }));
      ctx.note?.(csp, `CSP script-src ${host}`, VERDICT.FAIL);
    }
    return { findings: dedupe(findings), escalations };
  },
};
