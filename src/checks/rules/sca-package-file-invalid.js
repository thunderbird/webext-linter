// Rejects a source-code submission whose package.json cannot be used: it is not valid
// JSON, or it is valid JSON that is not an object. npm cannot read either, so the build
// the package file defines cannot be run and the shipped XPI cannot be reproduced from this
// archive.
//
// The two cases are worded apart because a developer would check which it is: one will not
// open at all, the other opens perfectly well and simply is not a package file. They are the
// same two the lock file's file-level faults carry, for the same reason.
//
// Decided from the one parse every reader of this file shares (src/vendor/package-file.js), so
// a package file this check calls unusable is exactly the one the dependency readers found
// nothing in. A second parse here would be a second set of tolerances, and the two could
// disagree about the same bytes.
//
// Not silenced by the shipped XPI being the archive's own code - the same grounds as its
// sibling, for the same reasons. The XPI-only advice is a separate question and prints
// beside this rejection.
//
// Belongs here: turning the fault into a finding and wording its subject. Does NOT belong
// here: the parse and its tolerances (-> src/vendor/package-file.js), whether the file is
// there at all (-> sca-package-file-missing), and the response (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { PACKAGE_FILE, packageFileFault } from "../../vendor/package-file.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const files = ctx.artifact.files;
    if (!files.has(PACKAGE_FILE)) {
      return { findings: [] };
    }
    const fault = packageFileFault(files.get(PACKAGE_FILE));
    if (!fault) {
      return { findings: [] };
    }
    // Which way it failed rides the location line, so the response states the rule once.
    const item =
      fault === "unreadable" ? "could not be read" : "is not a JSON object";
    ctx.note?.(PACKAGE_FILE, null, item, VERDICT.FAIL);
    return { findings: [finding({ file: PACKAGE_FILE, item })] };
  },
};
