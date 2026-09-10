// Info notice for a readable bundled file the tool could not confirm as a reviewed
// dependency. Two shapes reach it: the file was IDENTIFIED (its bytes match a pinned
// upstream release on the jsDelivr CDN or a declared VENDOR source) but did not clear
// the popularity trust bar; or its declared source was never checked at all - none
// given, an untrusted host, or no such release (applyUnverifiedVendor). So "match a
// known upstream release" is true of only the first, which is why the registry
// response names both. (A Mozilla hash-DB match is never gated - DB membership is the
// trust signal - so it never becomes untrusted.) It does not earn
// the trusted-library review exemption, so it is reviewed as authored code (the
// standard source-level checks scan it like the developer's own). This notice
// tells the dev why - otherwise an unsafe-html/etc. finding on a "library" file
// would be baffling. The popularity verdict + the untrusted tagging (which also
// removes the file from the non-authored skip set) happen earlier
// (src/lib/cdn-lookup.js, src/vendor/verify.js -> markUntrusted).
//
// Belongs here: selecting the readable untrusted entries and emitting one info
// finding per file. Does NOT belong here: the trust verdict / classification (->
// src/lib/bundled.js, cdn-lookup.js, src/vendor/verify.js), the
// minified/obfuscated reject (-> untrusted-minified-library.js), authored wording
// (-> registry.yaml), severity (-> that registry entry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { untrustedLibs } from "../../lib/bundled.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const findings = [];
    for (const lib of untrustedLibs(ctx)) {
      if (lib.unreadable) {
        continue; // a minified/obfuscated one is untrusted-minified-library's (reject) concern
      }
      const item = lib.name || lib.file;
      ctx.note?.(lib.file, null, item, VERDICT.INFO);
      findings.push(finding({ file: lib.file, item, hint: lib.source }));
    }
    return { findings };
  },
};
