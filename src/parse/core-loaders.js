// Finds the packaged files an add-on hands to an Experiment API as parameters, from
// the add-on's own WebExtension code. reachability.js uses this to bridge a plain
// `.html` parameter (a content page) into the WebExtension tree.
//
// Belongs here: extracting those raw references (scanExperimentInjectedRefs). Does NOT
// belong here: deciding which files exist / building the graph (->
// src/checks/lib/reachability.js), or the WebExtension loaders (->
// src/parse/local-imports.js, loader-files.js). Babel access goes through ast.js.

import { classifyUrl } from "../scan/url.js";
import { parseJs, traverse, nodeLoc } from "./ast.js";
import { basename } from "../util/files.js";

// A URL scheme (resource:, chrome:, moz-extension:, ...). A scheme-bearing parameter
// is matched by name; a relative path is resolved root-relative.
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

// The interchangeable WebExtension API roots an add-on may call an Experiment by.
const API_ROOTS = new Set(["browser", "messenger", "chrome"]);

/**
 * The dotted identifier names of a member-expression callee, root-first
 * (`messenger.WindowListener.registerWindow` -> ["messenger","WindowListener",
 * "registerWindow"]), or null if any link is computed or non-identifier.
 * @param {any} node
 * @returns {?string[]}
 */
function memberPath(node) {
  const parts = [];
  let cur = node;
  while (cur?.type === "MemberExpression") {
    if (cur.computed || cur.property?.type !== "Identifier") {
      return null;
    }
    parts.unshift(cur.property.name);
    cur = cur.object;
  }
  if (cur?.type !== "Identifier") {
    return null;
  }
  parts.unshift(cur.name);
  return parts;
}

/**
 * Classify a string passed to an Experiment API as a packaged-file reference: a
 * relative path is root-relative (WebExtension code passes add-on-relative paths),
 * a scheme URL (chrome://, resource://) is matched by name, anything else (a remote
 * URL, a window URL, a non-path string) is not a file ref.
 * @param {string} value
 * @returns {?{kind: "path"|"basename", value: string}}
 */
function classifyInjectedArg(value) {
  if (typeof value !== "string" || classifyUrl(value) !== "local") {
    return null;
  }
  return SCHEME_RE.test(value)
    ? { kind: "basename", value: basename(value) }
    : { kind: "path", value };
}

/**
 * Find the packaged-file paths an add-on hands to an Experiment API: string
 * arguments (top level, and one level inside an array argument) of any call
 * `browser|messenger|chrome.<ns>.…(args)` whose `<ns>` is in `namespaces`. Each ref is
 * tagged with its namespace.
 * @param {string} code
 * @param {Set<string>} namespaces  The add-on's Experiment namespaces.
 * @param {number} [lineOffset]
 * @returns {{refs: {ns: string, kind: "path"|"basename", value: string,
 *   line: number, column: number}[], parseError: string|null}}
 */
export function scanExperimentInjectedRefs(code, namespaces, lineOffset = 0) {
  const { ast, parseError } = parseJs(code);
  if (parseError || !ast || !namespaces?.size) {
    return { refs: [], parseError: parseError ?? null };
  }
  const refs = [];
  const addArg = (node, ns) => {
    if (node?.type !== "StringLiteral") {
      return;
    }
    const c = classifyInjectedArg(node.value);
    if (c) {
      refs.push({ ns, ...c, ...nodeLoc(node, lineOffset) });
    }
  };
  traverse(ast, {
    CallExpression(p) {
      const path = memberPath(p.node.callee);
      if (!path || path.length < 2) {
        return;
      }
      const [root, ns] = path;
      if (!API_ROOTS.has(root) || !namespaces.has(ns)) {
        return;
      }
      for (const arg of p.node.arguments) {
        if (arg?.type === "ArrayExpression") {
          for (const el of arg.elements) {
            addArg(el, ns);
          }
        } else {
          addArg(arg, ns);
        }
      }
    },
  });
  return { refs, parseError: null };
}
