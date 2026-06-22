// Finds add-on files referenced by PRIVILEGED core code (Experiment
// implementation files), which the WebExtension loaders in local-imports.js /
// loader-files.js do not cover. Core code reaches the add-on's own files two ways:
//   - `<x>.rootURI.resolve("<relpath>")` / `.baseURI.resolve(...)` - a root-relative
//     path, resolvable precisely (kind "path");
//   - a `chrome://` / `resource://` URL it registered for one of its files - the
//     registration is dynamic and unresolvable, so the file is matched by NAME
//     (kind "basename"). The caller checks whether a packaged file with that name
//     exists; a core/app URL with no such file is simply ignored, never flagged.
// These appear bare, or as arguments to `ChromeUtils.importESModule`,
// `ChromeUtils.defineESModuleGetters`, `loadSubScript`, or a static `import … from`.
// A non-literal argument (a variable, `__SCRIPT_URI_SPEC__`) is ignored.
//
// Belongs here: extracting those raw references as reference-graph input. Does NOT
// belong here: deciding which files exist / building the graph (->
// src/checks/lib/reachability.js, which calls this only within the Experiment
// subtree), or the WebExtension loaders (-> src/parse/local-imports.js,
// loader-files.js). Babel access goes through src/parse/ast.js.

import { classifyUrl } from "../scan/url.js";
import { parseJs, traverse, nodeLoc } from "./ast.js";
import { basename } from "../util/files.js";

// A URL scheme (resource:, chrome:, moz-extension:, ...). Only a scheme-bearing URL
// is matched by name; a relative path is the WebExtension loaders' job (a bare
// basename match on a relative import could collide with an unrelated namesake).
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The root-relative path of a `<obj>.resolve("<str>")` call whose object is a
 * `rootURI` / `baseURI` (the privileged add-on-file resolver), or null.
 * @param {any} node
 * @returns {?string}
 */
function rootUriResolvePath(node) {
  if (node?.type !== "CallExpression") {
    return null;
  }
  const callee = node.callee;
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    callee.property?.name !== "resolve"
  ) {
    return null;
  }
  const obj = callee.object;
  const objName =
    obj?.type === "MemberExpression" && !obj.computed
      ? obj.property?.name
      : obj?.type === "Identifier"
        ? obj.name
        : null;
  if (objName !== "rootURI" && objName !== "baseURI") {
    return null;
  }
  const arg = node.arguments?.[0];
  return arg?.type === "StringLiteral" ? arg.value : null;
}

/**
 * @param {string} code  JavaScript source text.
 * @param {number} [lineOffset]  Added to reported lines (for inline scripts).
 * @returns {{refs: {kind: "path"|"basename", value: string, line: number,
 *   column: number}[], parseError: string|null}}
 */
export function scanCoreLoaderRefs(code, lineOffset = 0) {
  const { ast, parseError } = parseJs(code);
  if (parseError || !ast) {
    return { refs: [], parseError };
  }
  const refs = [];
  // A string-literal module URL -> a basename reference. Remote/embedded URLs are
  // never add-on files (the remote-script check owns those), so they are dropped.
  const addLiteral = (node) => {
    if (node?.type !== "StringLiteral") {
      return;
    }
    const url = node.value;
    if (classifyUrl(url) !== "local" || !SCHEME_RE.test(url)) {
      return;
    }
    const base = basename(url);
    if (base) {
      refs.push({
        kind: "basename",
        value: base,
        ...nodeLoc(node, lineOffset),
      });
    }
  };
  traverse(ast, {
    ImportDeclaration: (p) => addLiteral(p.node.source),
    ExportNamedDeclaration: (p) => p.node.source && addLiteral(p.node.source),
    ExportAllDeclaration: (p) => addLiteral(p.node.source),
    CallExpression(p) {
      // A `rootURI.resolve("path")` call anywhere (bare, or wrapped in a loader)
      // references an add-on file at that root-relative path.
      const rel = rootUriResolvePath(p.node);
      if (rel != null) {
        refs.push({ kind: "path", value: rel, ...nodeLoc(p.node, lineOffset) });
        return;
      }
      const callee = p.node.callee;
      if (callee?.type !== "MemberExpression" || callee.computed) {
        return;
      }
      const method = callee.property?.name;
      if (method === "importESModule" || method === "loadSubScript") {
        addLiteral(p.node.arguments[0]);
      } else if (method === "defineESModuleGetters") {
        const obj = p.node.arguments[1];
        if (obj?.type === "ObjectExpression") {
          for (const prop of obj.properties) {
            if (prop.type === "ObjectProperty") {
              addLiteral(prop.value);
            }
          }
        }
      }
    },
  });
  return { refs, parseError: null };
}

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
 * `browser|messenger|chrome.<ns>.…(args)` whose `<ns>` is in `namespaces`. Each ref
 * is tagged with its namespace so the caller can apply that namespace's
 * core/webext/unsure classification.
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
