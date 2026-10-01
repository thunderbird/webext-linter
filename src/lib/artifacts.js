// WHERE a finding's subject is: in the built XPI the user installs, in the source code
// archive a source review reads, or in neither. A submission has both artifacts, and the
// same relative path (background.js, package.json) can exist in each, so anything naming a
// path has to say which one it means - and a reminder settled by looking at the listing
// page or at the running add-on has to be able to say it is in neither.
//
// Named here, in the neutral layer, because the ARTIFACT owns the answer: an Addon carries
// its own kind (src/addon/load.js), every locus is minted by the thing holding the file,
// and both the checks and the report read it from there. Putting the vocabulary in the
// report layer would have the add-on loader importing the reporter to say what it is.
//
// PLAIN STRINGS, deliberately, and NOT a makeEnum: an enum member is a strict Proxy that
// throws on JSON.stringify ("unknown <label>: toJSON"), and this value is serialized into
// the machine-readable report, the review loop's state file and the file an agent hands
// back. A value that cannot survive JSON cannot be a finding's field.
//
// THE RULE, in one line: a locus's artifact comes from the thing that holds the file.
// Three things hold files, and each answers for itself:
//
//   ctx.artifact          the artifact this check was routed to, and where nearly every
//                         locus comes from: `ctx.artifact.at(file, loc)`.
//   ctx.manifest          the shipped manifest.json, a review-level singleton read from
//                         the built XPI, and always a record (absent or not). A check
//                         reporting against a manifest value is reporting into an artifact
//                         it may not have been routed to, so it asks the record - there is
//                         no route that could describe this.
//   ctx.xpi / ctx.sca     the sides of the `all` route, which names none of them. A check
//                         there mints from the side it means: ctx.xpi.artifact.at(...).
//
// NOTHING MAY NAME A PATH WITHOUT ITS HOLDER. A finding, an escalated case and a feed note
// all carry a locus, and assertLocus below refuses one that cannot say which artifact it
// is in - the same contract for all three, because a reader downstream cannot tell which
// made it and a filename is not evidence of anything. It throws a WIRING error, so a
// producer that forgot exits 2 rather than losing its other findings to a check-failed.
//
// Belongs here: the names, the predicate over them, their roots lookup, and the one guard
// every producer of a locus is held to. Does NOT belong here: deciding which one a locus is in (the holders
// above), or how it is SHOWN (-> src/report/artifact.js artifactLabel, which prints it
// only where there are two artifacts to tell apart).

import { wiringError } from "./errors.js";

/** A file in the submitted built XPI. */
export const ARTIFACT_XPI = "XPI";

/** A file in the submitted source code archive. */
export const ARTIFACT_SCA = "SCA";

/** NOT in the submission: the add-on as the public meets it - its listing page, and its
 *  behaviour once installed. What a by-hand reminder is about (`input: none`), and the
 *  reason such an entry is handed over with no tree: there is none to open. Distinct from
 *  the absence of an answer, which no locus may be (assertLocus). */
export const ARTIFACT_NONE = "NONE";

/**
 * Refuse anything that is not a LOCUS - `{file, loc, artifact}` as a holder mints it
 * (src/addon/load.js `at`).
 *
 * ONE guard for all three producers - a finding, an escalated case, a feed note - because
 * they carry the same thing and a reader downstream cannot tell which made it. Held apart,
 * they drift: the feed note was once stricter than the finding, so a path of `42` was
 * refused on a line printed once and accepted into the JSON report, the review state and
 * the file an agent opens.
 *
 * `artifact` is required as hard as `file`, and required with NO file too. An entry with
 * no artifact is handed over with no root (src/report/handback.js entriesFor), and the
 * claims with no file are the ones that most need the tree: a manifest.json that is not
 * there, a package an archive should not carry.
 * @param {*} at  The locus to check.
 * @param {string} who  What is being built, for the message - the reader has to find the
 *   producer, and by the time a bad locus is visible downstream nothing names it.
 * @returns {void}
 */
export function assertLocus(at, who) {
  const bad =
    at === null ||
    typeof at !== "object" ||
    Array.isArray(at) ||
    at.file === "" ||
    (at.file !== null && typeof at.file !== "string") ||
    !isArtifact(at.artifact);
  if (bad) {
    // WIRING, not a check crashing on input nobody anticipated: a producer that cannot say
    // where it is pointing is this codebase being wrong. A plain Error here would be caught
    // by runOneCheck and laundered into a check-failed finding, losing every other finding
    // that check had already produced while the review still shipped.
    throw wiringError(
      `${who} needs a locus minted by whatever holds the file - {file, loc, artifact} - ` +
        `got ${JSON.stringify({ file: at?.file, artifact: at?.artifact })}. Ask ` +
        "ctx.artifact.at(file, loc), or the holder it is really in: the shipped " +
        "manifest.json record, or the side of the `all` route you mean."
    );
  }
}

/**
 * The review's two trees, keyed by the artifact each one holds - the lookup that turns an
 * artifact into a directory a reader can open.
 *
 * ONE spelling of the pair, for the same reason the names above are named once: three
 * readers need it - the report's sweep list, the paths handed to an agent, and the check
 * on whether this review even has that tree - and a second table written out beside one
 * of them is one that drifts from what a locus is stamped with.
 *
 * Takes whatever carries the two roots, because they travel under those names everywhere:
 * the review's `meta`, and the loop state's `paths`. `null` for a tree this review has
 * not got, which is every source archive in an XPI review - the absence IS the answer,
 * and a caller asks it rather than asking the review mode a second time.
 * @param {{xpiRoot?: ?string, scaRoot?: ?string}} where
 * @returns {Record<string, ?string>}
 */
export function artifactRoots(where) {
  return {
    [ARTIFACT_XPI]: where?.xpiRoot ?? null,
    [ARTIFACT_SCA]: where?.scaRoot ?? null,
  };
}

/**
 * Whether a value is one of the subjects above. Beside them because a second spelling of
 * "these are the ones" is one that goes out of step.
 * @param {*} x
 * @returns {boolean}
 */
export function isArtifact(x) {
  return x === ARTIFACT_XPI || x === ARTIFACT_SCA || x === ARTIFACT_NONE;
}
