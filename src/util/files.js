// File-classification primitives shared across the whole tool: which add-on
// paths count as JavaScript or HTML, and the small path helpers built on them.
// One neutral home (importable from every layer) so the extension sets cannot
// drift between the source collector, the normalizer, and the checks.
//
// Belongs here: pure path/extension string helpers (extname, basename) and the
// JS_EXTENSIONS / CSS_EXTENSIONS / HTML_EXTENSIONS sets. No filesystem IO and no
// dependencies. Does NOT belong here: reading files off disk or out of an
// archive - that is src/addon/load.js for the add-on and src/schema/load.js for
// schemas.

/** Extensions treated as JavaScript source. */
export const JS_EXTENSIONS = new Set([".js", ".mjs", ".jsm", ".es", ".es6"]);

/** Extensions treated as CSS stylesheets. */
export const CSS_EXTENSIONS = new Set([".css"]);

/** Extensions treated as HTML documents. */
export const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

/**
 * Lowercased file extension including the dot (e.g. ".html"), or "".
 * @param {string} file
 * @returns {string}
 */
export function extname(file) {
  const i = file.lastIndexOf(".");
  return i === -1 ? "" : file.slice(i).toLowerCase();
}

/**
 * The final path segment of an add-on-relative posix path.
 * @param {string} file
 * @returns {string}
 */
export function basename(file) {
  return file.slice(file.lastIndexOf("/") + 1);
}
