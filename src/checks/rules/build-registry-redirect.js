// Rejects a source-code submission whose .npmrc SETS a package registry. npm/pnpm read
// .npmrc for `registry=` (the default) and `@scope:registry=` (per scope); a legitimate
// build never needs to set either (npm already defaults to the public registry), so ANY
// registry setting is disallowed outright - it can only point the install at a source
// other than the public npm registry, pulling the SAME declared package names from an
// UNDECLARED source and leaving package.json/lock a clean decoy. The value is NOT parsed
// (no host/quote/case handling to slip past); the mere presence of the key is the
// reject. Deterministic, no network.
//
// input: sca - reads the submitted source archive off ctx.artifact. The ARCHIVE'S OWN .npmrc is the
// one read: npm takes its config from the directory the install runs in, and the review
// runs it at --sca-root, so that is the file whose settings reach the install. A config
// deeper in the tree belongs to a directory this review never installs from, so it is never
// asked for: this reads the one root key and never scans for others.
//
// Belongs here: flagging .npmrc registry settings. Does NOT belong here: which files are
// in the source view (-> src/addon/load.js scaViews) or the wording (-> the registry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const files = ctx.artifact?.files;
    if (!files) {
      return { findings: [] };
    }
    const buf = files.get(".npmrc");
    if (!buf) {
      return { findings: [] };
    }
    const findings = [];
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const value = registrySetting(lines[i]);
      if (value !== null) {
        const loc = { line: i + 1 };
        ctx.note?.(".npmrc", loc, "sets a package registry", VERDICT.FAIL);
        findings.push(finding({ file: ".npmrc", loc, item: value }));
      }
    }
    return { findings };
  },
};

/**
 * If this .npmrc line sets a package registry (`registry=` or `@scope:registry=`,
 * matched case-INSENSITIVELY), return the raw value it is set to (or the key itself when
 * the value is empty, so the finding always has a subject); otherwise null. Comments,
 * auth lines, and unrelated keys are ignored. The value is NOT validated - ANY registry
 * setting is rejected.
 * @param {string} line
 * @returns {?string}
 */
function registrySetting(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
    return null;
  }
  const eq = trimmed.indexOf("=");
  if (eq === -1) {
    return null;
  }
  // Lower-case per the disallow-ANY-registry policy, and drop npm's `[]` array-append
  // suffix: npm honors `registry[]=<url>` as the same registry config, so it must be
  // caught too (only the exact `[]` suffix - `registry[0]=` is not honored by npm).
  const key = trimmed.slice(0, eq).trim().toLowerCase().replace(/\[\]$/, "");
  if (key !== "registry" && !/^@[^:]+:registry$/.test(key)) {
    return null;
  }
  return trimmed.slice(eq + 1).trim() || key;
}
