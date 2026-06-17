// Referenced files must be bundled. Flags add-on-internal files that are
// referenced but not present in the package:
//   - manifest entries: content_scripts js/css, background scripts/page/
//     service_worker, options_ui.page, *_action.default_popup,
//   - file-loading API calls: every packaged-file path the schema-directed +
//     bridge extractor finds (register/setIcon/theme/menus, executeScript/
//     insertCSS, getURL, tabs.create, *.setPopup, ...) - see loader-files.js.
// Complements the remote-script check (which catches remote sources).
//
// Belongs here: gathering referenced paths from both sources, keeping only
// packaged-file candidates (relative/root-relative, no scheme), and emitting a
// finding for each that is absent from the package.
//
// Does NOT belong here: extracting manifest file refs (-> src/checks/lib/
// manifest-refs.js), extracting loader-API file refs (->
// src/parse/loader-files. js), URL classification (-> src/scan/url.js), the
// remote-source verdict (-> remote-script.js), authored wording (->
// assets/registry.yaml), severity (-> that registry entry, stamped by
// src/checks/registry.js), and report formatting (-> src/report/format.js).

import { finding } from "../../report/finding.js";
import { scanLoaderRefs } from "../../parse/loader-files.js";
import { classifyUrl } from "../../scan/url.js";
import { manifestFileRefs, normalizeRef } from "../lib/manifest-refs.js";

// A reference is a packaged-file candidate (so a missing target is an error)
// only when it is a relative / root-relative path with no URI scheme. This
// drops remote urls and pseudo-schemes a loader may legitimately receive
// (about:, moz-extension:, chrome:, resource:, mailto:, ...) and bare fragments.
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export default {
  run(ctx) {
    const { addon } = ctx;
    const out = [];
    /** @param {string} p @returns {boolean} whether the file is bundled. */
    const has = (p) => addon.files.has(normalizeRef(p));

    // 1. Files referenced from the manifest.
    if (addon.manifest) {
      for (const { path } of manifestFileRefs(addon.manifest)) {
        if (typeof path !== "string") {
          continue;
        }
        const present = has(path);
        ctx.note?.("manifest.json", null, path, present ? "pass" : "fail");
        if (!present) {
          out.push(finding({ file: "manifest.json", item: path }));
        }
      }
    }

    // 2. Files referenced by file-loading API calls (schema-directed + bridge).
    const seen = new Set();
    for (const src of ctx.jsSources) {
      const { refs } = scanLoaderRefs(
        src.code,
        src.lineOffset,
        ctx.schema,
        ctx.schema?.manifestVersionMajor
      );
      for (const ref of refs) {
        if (!isPackagedPathRef(ref.path)) {
          continue;
        }
        const dedupKey = `${src.file}|${normalizeRef(ref.path)}`;
        if (seen.has(dedupKey)) {
          continue;
        }
        seen.add(dedupKey);
        const loc = { line: ref.line, column: ref.column };
        const present = has(ref.path);
        ctx.note?.(src.file, loc, ref.path, present ? "pass" : "fail");
        if (!present) {
          out.push(finding({ file: src.file, loc, item: ref.path }));
        }
      }
    }

    return out;
  },
};

/**
 * True if a reference looks like a packaged add-on file (relative / root-
 * relative, no URI scheme, not a bare fragment), so a missing target is a real
 * "not bundled" error rather than an external/remote resource.
 * @param {string} raw  Referenced path.
 * @returns {boolean}
 */
function isPackagedPathRef(raw) {
  const s = String(raw ?? "").trim();
  if (s === "" || s.startsWith("#")) {
    return false;
  }
  if (SCHEME_RE.test(s)) {
    return false; // about:, moz-extension:, chrome:, http:, ...
  }
  return classifyUrl(s) === "local"; // also drops protocol-relative "//host/x"
}
