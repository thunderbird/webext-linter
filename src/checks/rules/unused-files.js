// Files that should not ship in a published add-on. The scan (reachability.js
// follows import/getURL/HTML/CSS plus file-loading API edges) resolves the clear
// cases as findings: hidden/junk by name, and a clearly-unreferenced file (its
// basename appears in no other file AND the add-on uses no dynamic loaders). For
// an ambiguous file (its name appears in live code, or the add-on builds load
// paths at runtime) we cannot tell statically whether any of those sites really
// loads it, so the file escalates for a reviewer to follow the suspected loaders
// and decide whether anything loads it.
//
// Belongs here: the ALLOW / JUNK name lists, and classifying each packaged file as
// a finding / escalation / clean against reachability. Does NOT belong here: the
// reachability graph, dynamic-loader sites, and mention lookups -> src/lib/
// reachability.js. The non-authored (library / minified / bundled) classification
// -> nonAuthoredJs in src/lib/bundled.js. The deterministic->manual routing ->
// src/checks/registry.js + src/checks/escalation.js. Authored wording ->
// assets/registry.yaml. Severity -> that registry entry, stamped by runChecks.

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { ARCHIVE_EXTENSIONS, extname } from "../../util/files.js";
import { nonAuthoredJs } from "../../lib/bundled.js";
import { buildReachability } from "../../lib/reachability.js";
import {
  referrerSupported,
  loaderTrace,
  isDocMetadataFile,
  isExperiment,
} from "../../lib/util.js";
import { PACKAGE_FILE } from "../../vendor/package-file.js";
import { TREE_LOCKS } from "../../vendor/locks.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

// Never flag: locale message catalogs, the ROOT package.json, and the ROOT lock file
// BESIDE IT. The package.json is the one build-manager file a built XPI actually reads, as
// the vendored-library declarations behind unsupported-dependency / vendor-vulnerable; the lock
// beside it is read too, for the version a declared range resolves to
// (src/vendor/resolve.js classifyDeps).
//
// The lock is exempt because the review ASKS for it: xpi-lock-file-missing tells a
// developer shipping a range to commit one, and reporting the same file as unused would
// answer that with the opposite instruction. That reason needs the package file to exist -
// with no package.json there is no declaration to resolve, nothing ever reads the lock,
// and no check asks for it, so a lock shipped alone is an unused file like any other and
// is reported. Exempting it on the strength of its NAME would be the one case where this
// check stays quiet about a file nothing in the submission can use.
//
// Only at the ROOT, and nothing else in that family at any depth: a package.json or a lock
// below the root declares nothing this review resolves, so those are exactly what this
// check exists to report. An .npmrc needs no entry either way - the JUNK rule below is
// tested first and reports every dotfile.
//
// Documentation / project metadata is exempted separately by isDocMetadataFile
// (a documentation extension settles it; a .txt or an extensionless file needs a
// known doc name too).
const ALLOW = [/^_locales\//];

// The add-on's own manifest.json. Spelled out rather than imported, as every other rule that
// names it does - PACKAGE_FILE beside it is npm's package.json, a different file.
const WEBEXT_MANIFEST = "manifest.json";

// Definite "should not ship" by name: OS/editor junk, source maps. Archives are handled
// separately via ARCHIVE_EXTENSIONS (shared with the loader / committed-build-artifact).
const JUNK = [
  /(^|\/)\.[^/]+(\/|$)/, // a dotfile/dotdir segment (.git/, .DS_Store, .vscode/)
  /(^|\/)(Thumbs\.db|__MACOSX(\/|$))/i,
  /~$/, // editor backups
  /\.(map|orig|bak|swp|tmp)$/i,
];

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[],
   *   escalations?: import("../escalation.js").Escalation[]}}
   */
  run(ctx) {
    // Registry `input: xpi`: ctx.artifact is the built XPI. A file bundled but reached
    // from no entry point is dead weight in what actually ships, so this runs over
    // the XPI - over a source submission it would instead flag every unreferenced
    // config / test / doc in the repo (all noise), while the XPI surfaces the build's
    // own dead files. (The reachability graph is the same XPI's.)
    const { artifact } = ctx;
    const reach = buildReachability(ctx);
    // Recognized third-party files are not the developer's authored code, so an
    // unreached one is not the developer's unused file - exempt it. The set
    // (hash-identified libraries, minified bundles, obfuscated code, vendored files)
    // is the XPI's own classification (getBundled over ctx.artifact), intrinsic to the
    // artifact under review, so it needs no cross-artifact review-target metadata.
    const skip = new Set(nonAuthoredJs(ctx));
    // The lock's exemption is the package file's: see the header. Read once, not per file.
    const packageFileShipped = artifact.files.has(PACKAGE_FILE);
    // An Experiment loads its files by mechanisms static analysis can't trace, so
    // "not reachable" is unreliable there - we'd mostly flag working experiment code.
    // Report only unambiguous junk; a separate "review the whole Experiment" check
    // (out of scope) prompts the manual pass.
    const experiment = isExperiment(ctx.manifest?.json);
    const findings = [];
    const escalations = [];

    for (const file of artifact.files.keys()) {
      // Junk outranks every exemption: a leaked .git/ or .vscode/ is debris
      // whatever it holds, and a document or a vendored library inside one is
      // no reason to ship the directory.
      if (
        JUNK.some((re) => re.test(file)) ||
        ARCHIVE_EXTENSIONS.has(extname(file))
      ) {
        ctx.note?.(file, null, "hidden/junk file", VERDICT.FAIL);
        findings.push(finding({ file }));
        continue;
      }
      if (
        // The add-on manifest.json is the ENTRY POINT, not a referenced resource: nothing in the
        // add-on can point at it, so "nothing references it" says nothing about whether it
        // is used. Skipped by name here, not withheld from the files: one check's
        // exemption is not a reason to hide a file from every other reader.
        file === WEBEXT_MANIFEST ||
        file === PACKAGE_FILE ||
        (packageFileShipped && TREE_LOCKS.includes(file)) ||
        skip.has(file) ||
        isDocMetadataFile(file) ||
        ALLOW.some((re) => re.test(file))
      ) {
        continue;
      }
      if (experiment) {
        continue; // junk only for Experiments; reachability-unused is unreliable
      }
      if (reach.reachable.has(file)) {
        continue;
      }
      // Unreachable. A reference from live code (whether it is a real load is the
      // reviewer's call) or a live dynamic loader makes it ambiguous. A file
      // named only by dead code with no live loader is a clear orphan.
      const mentions = reach.mentionsOf(file);
      const supported = mentions.some((m) => referrerSupported(reach, m.file));
      const orphan = !supported && !reach.hasDynamicLoaders;
      ctx.note?.(
        file,
        null,
        loaderTrace(reach, mentions, supported),
        orphan ? VERDICT.FAIL : VERDICT.UNSURE
      );
      if (orphan) {
        findings.push(finding({ file }));
        continue;
      }
      // The entry names `file` as its locus; the suspected loader sites reached it
      // and are narrated to the feed above, so the reviewer has where to look.
      escalations.push({ file });
    }

    return { findings, escalations };
  },
};
