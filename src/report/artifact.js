// How an artifact is SHOWN before a `file:line`:
//   [XPI] = a file in the submitted built XPI
//   [SCA] = a file in the submitted source code archive
// A source submission has both, and the same relative path (background.js, manifest.json)
// can exist in each, so a reviewer needs telling which one a finding means. An XPI review
// has one artifact and labels nothing.
//
// Presentation only. WHICH artifact a locus is in is settled long before this, by the
// thing that holds the file: an Addon carries its `kind` and mints loci with `at`
// (src/addon/load.js), the shipped manifest.json record does the same for a value inside
// it, and every finding, escalated case and feed note carries the locus it minted. So this
// takes the answer and never works one out - there is no rule here to disagree with the
// one upstream.
//
// Belongs here: the label. Does NOT belong here: deciding which artifact a locus is in
// (the holder answers), the artifact names themselves (-> src/lib/artifacts.js), or
// prepending the label to a rendered line (-> src/report/format.js locationLine,
// src/checks/registry.js formatNote).

/**
 * How that artifact is SHOWN before a `file:line`, or "" when it needs no saying.
 *
 * Only a source review has two artifacts to tell apart, so only a source review labels
 * anything. Presentation over the fact above, which is why it takes the answer rather than
 * working it out again.
 * @param {{artifact?: string, mode?: object}} params
 * @returns {string} "XPI", "SCA", or "" (an XPI review - a single artifact).
 */
export function artifactLabel({ artifact, mode }) {
  return mode?.sca ? (artifact ?? "") : "";
}
