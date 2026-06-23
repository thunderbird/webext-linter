// Flags privileged Thunderbird/Firefox "core" globals (Services, ChromeUtils, the
// Components/Cc/Ci/Cu family, ...) used in PURE WebExtension code. A WebExtension
// sandbox - background, content, options and popup scripts - has no chrome
// privileges and does not expose these symbols, so a global reference to one is
// either a bug or privileged code mis-packaged as a WebExtension file. So the check
// runs ONLY on the pure WebExtension dependency tree (pureWebExtensionReachable):
// files reached from a WebExtension entry point without crossing into an Experiment
// API. This positively excludes privileged Experiment/core code (and the mixed/
// "unsure" files) and dead code - independent of how completely the Experiment tree
// was traced, so an untraceable privileged loader cannot cause a false positive.
//
// Belongs here: the core-symbol list and visiting GLOBAL references to it (a name
// shadowed by a local binding / import is the developer's own symbol, not ours).
// Does NOT belong here: the WebExtension vs Experiment partition (->
// src/checks/lib/reachability.js, pureWebExtensionReachable), Babel plumbing (->
// src/parse/ast.js), the non-authored skip-list (-> src/checks/lib/bundled.js),
// authored wording / severity (-> assets/registry.yaml), report formatting (->
// src/report/format.js).

import { finding } from "../../report/finding.js";
import { parseJs, traverse, nodeLoc } from "../../parse/ast.js";
import { nonAuthoredJs } from "../lib/bundled.js";
import { buildReachability } from "../lib/reachability.js";

// Privileged globals a WebExtension sandbox never provides. The short
// Components shortcuts (Cc/Ci/Cu/Cr/Cm) and the Extension* Experiment base globals
// are included; all are matched only as GLOBAL references (a shadowing local binding
// or import of the same name is exempt).
const CORE_SYMBOLS = new Set([
  "Services",
  "Components",
  "Cc",
  "Ci",
  "Cu",
  "Cr",
  "Cm",
  "ChromeUtils",
  "XPCOMUtils",
  "ctypes",
  "IOUtils",
  "PathUtils",
  "ChromeWorker",
  "ExtensionCommon",
  "ExtensionAPI",
  "ExtensionParent",
]);

export default {
  run(ctx) {
    const out = [];
    const skip = nonAuthoredJs(ctx); // a core symbol in a bundled library is not the dev's
    // Only check files in the pure WebExtension dependency tree: reachable from a
    // WebExtension entry point without crossing into an Experiment API. This excludes
    // privileged Experiment/core code (and the mixed/"unsure" files), which
    // legitimately uses these symbols, and dead code that never runs - positively,
    // without depending on how completely the Experiment tree was traced.
    const webext = buildReachability(ctx).pureWebExtensionReachable;
    for (const src of ctx.jsSources) {
      if (skip.has(src.file) || !webext.has(src.file)) {
        continue;
      }
      const { ast } = src.parsed ?? parseJs(src.code);
      if (!ast) {
        continue;
      }
      const seen = new Set(); // one finding per (file, symbol)
      traverse(ast, {
        ReferencedIdentifier(path) {
          const name = path.node.name;
          // A core global: in CORE_SYMBOLS, an actual reference (not a property
          // name / object key / declaration - ReferencedIdentifier guarantees that),
          // and NOT shadowed by a local binding or import.
          if (
            !CORE_SYMBOLS.has(name) ||
            seen.has(name) ||
            path.scope.hasBinding(name)
          ) {
            return;
          }
          seen.add(name);
          const loc = nodeLoc(path.node, src.lineOffset);
          ctx.note?.(src.file, loc, name, "fail");
          // The registry response carries no {{item}}, so the resolver collapses
          // these into one grouped entry and surfaces `item` (the symbol) on each
          // locus line ("file:line - Services") - see report/responses.js + format.js.
          out.push(finding({ file: src.file, loc, item: name }));
        },
      });
    }
    return out;
  },
};
