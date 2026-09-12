// A small wrapper around the markup parsers, shared by the inline-script
// extractor, the Vue SFC extractor (src/scan/vue-sfc.js) and the
// remote-reference scanner. Using a real (spec-compliant)
// parser instead of regexes means attribute values that contain ">", quoting,
// comments and CDATA are handled correctly, and element/line positions come
// from parse5's source-location info rather than newline counting.
//
// Two parsers, chosen by the DOCUMENT and never by the caller: parse5 for HTML,
// htmlparser2 in xmlMode for a document that declares itself XML with an `<?xml`
// prolog. They differ on exactly the thing that matters here - HTML has no
// self-closing `<script/>`, so in an XHTML document parsed as HTML the tag never
// closes and the rest of the file becomes that script's text. Every later script is
// then invisible, in the `.xhtml` documents this codebase ties to PRIVILEGED UI.
// The prolog is the signal because it is what the author declared: an `xmlns` is not,
// since legacy XHTML 1.0 pages carry one and are served, and parsed, as HTML.
//
// Belongs here: the parser front door - low-level parsing primitives (element
// walking, attribute access, raw-text/line positions) and the choice of parser. Any
// code needing to parse markup goes through here, analogous to how src/parse/ast.js
// is the Babel front door.
//
// Does NOT belong here: deciding what markup facts matter - higher-level HTML
// scanning is src/scan/html.js and inline-script extraction is
// src/addon/sources.js. JavaScript AST parsing is a different subsystem
// (src/parse/ast.js).

import { parse } from "parse5";
import { parseDocument } from "htmlparser2";

/** A document that declares itself XML. Leading BOM tolerated. */
const XML_PROLOG = /^\uFEFF?\s*<\?xml/;

/**
 * A parse5 tree location (the subset we read).
 * @typedef {object} Parse5Location
 * @property {number} [startLine]  1-based start line.
 * @property {{startLine?: number}} [startTag]  Start-tag location.
 * @property {Object<string, {startLine?: number}>} [attrs]  Per-attribute
 *   locations, keyed by attribute name.
 */

/**
 * A raw parse5 tree node (the subset this wrapper reads). parse5's own node
 * types are a generic adapter map, so this names just the fields we touch.
 * @typedef {object} Parse5Node
 * @property {string} [tagName]  Tag name (element nodes).
 * @property {string} [nodeName]  Node name ("#text" for text nodes).
 * @property {string} [value]  Text content (text nodes).
 * @property {{name: string, value: string}[]} [attrs]  Element attributes.
 * @property {Parse5Node[]} [childNodes]  Child nodes.
 * @property {Parse5Node} [content]  Fragment holding a <template>'s children.
 * @property {Parse5Location} [sourceCodeLocation]  Source position.
 */

/**
 * @typedef {object} HtmlElement
 * @property {string} tag  Lowercased tag name.
 * @property {(name: string) => (string|null)} attr  Attribute value, or null.
 * @property {{name: string, value: string, line: number}[]} attrList  Every
 *   attribute (lowercased name) with its value and 1-based start line. Used to
 *   scan directive attributes whose name is not known ahead of time (Vue `:x`,
 *   `@x`, `v-x`).
 * @property {number} line  1-based line of the element's start tag.
 * @property {{value: string, startLine: number}|null} rawText  The raw text
 *   child for rawtext elements (script/style): its content and the 1-based line
 *   where it begins. Null when the element has no text child.
 */

/**
 * Invoke `callback` for every element in an HTML document, in document order,
 * INCLUDING the contents of a <template> (parse5 keeps that off `childNodes`, as a
 * separate fragment).
 *
 * Template contents are walked because they are code the page can run: cloning a
 * template's content into the document carries the script's unstarted state with it,
 * so it executes on insertion. A scanner asking what a document can do must not get a
 * different answer because the markup was parked in a <template> first - and a place
 * every scanner is blind to is worth exactly as much to someone hiding something as it
 * is cheap, whether or not anyone legitimate uses it.
 * @param {string} html  HTML source text.
 * @param {(el: HtmlElement) => void} callback
 */
export function eachElement(html, callback) {
  if (XML_PROLOG.test(html)) {
    eachXmlElement(html, callback);
    return;
  }
  const doc = parse(html, { sourceCodeLocationInfo: true });
  /** @param {Parse5Node} node  parse5 node whose children to visit. */
  const walk = (node) => {
    for (const child of node.childNodes || []) {
      if (child.tagName) {
        callback(toElement(child));
      }
      walk(child);
    }
    if (node.content) {
      walk(node.content);
    }
  };
  walk(doc);
}

/**
 * Collect the visible text of an HTML document: every `#text` node's content,
 * skipping the rawtext children of `script`/`style` (code, not user-facing
 * copy). Whitespace is preserved as-is. The caller collapses it. Used by the
 * language check to extract user-facing strings.
 * @param {string} html  HTML source text.
 * @returns {string}  Text fragments joined by single spaces.
 */
export function visibleText(html) {
  if (XML_PROLOG.test(html)) {
    return xmlVisibleText(html);
  }
  const doc = parse(html);
  const parts = [];
  /** @param {Parse5Node} node  parse5 node whose children to visit. */
  const walk = (node) => {
    for (const child of node.childNodes || []) {
      const tag = child.tagName?.toLowerCase();
      if (tag === "script" || tag === "style") {
        continue; // rawtext element - its text is code, not user-facing copy
      }
      if (child.nodeName === "#text" && typeof child.value === "string") {
        parts.push(child.value);
      }
      walk(child);
    }
  };
  walk(doc);
  return parts.join(" ");
}

/**
 * Adapt a parse5 element node to the HtmlElement shape.
 * @param {Parse5Node} node  A parse5 element node.
 * @returns {HtmlElement}
 */
function toElement(node) {
  const rawAttrs = node.attrs || [];
  const attrs = new Map(rawAttrs.map((a) => [a.name.toLowerCase(), a.value]));
  const loc = node.sourceCodeLocation;
  const line = loc ? (loc.startTag?.startLine ?? loc.startLine ?? 1) : 1;
  const attrLocs = loc?.attrs || {};
  const attrList = rawAttrs.map((a) => {
    const name = a.name.toLowerCase();
    const al = attrLocs[name] ?? attrLocs[a.name];
    return { name, value: a.value, line: al?.startLine ?? line };
  });
  const textNode = (node.childNodes || []).find((c) => c.nodeName === "#text");
  const rawText =
    textNode && textNode.sourceCodeLocation
      ? {
          value: textNode.value,
          startLine: textNode.sourceCodeLocation.startLine,
        }
      : null;
  return {
    tag: node.tagName.toLowerCase(),
    attr: (name) => (attrs.has(name) ? attrs.get(name) : null),
    attrList,
    line,
    rawText,
  };
}

/**
 * Line number (1-based) for a source offset, from a precomputed newline index.
 * htmlparser2 reports offsets where parse5 reports lines, so the XML path converts
 * once per document rather than counting newlines per node.
 * @param {number[]} starts  Offset of the first character of each line.
 * @param {number} offset
 * @returns {number}
 */
function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1;
}

/** @param {string} text @returns {number[]} */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * eachElement for a document that declares itself XML. Same HtmlElement shape, so no
 * consumer can tell which parser ran. `attrList` carries the element's line for every
 * attribute: htmlparser2 reports no per-attribute position, and the one consumer that
 * reads those lines (src/scan/vue-sfc.js) works on .vue files, which are never XML
 * documents.
 * @param {string} html @param {(el: import("./html-parse.js").HtmlElement) => void} callback
 */
function eachXmlElement(html, callback) {
  const starts = lineStarts(html);
  const doc = parseDocument(html, {
    xmlMode: true,
    withStartIndices: true,
    withEndIndices: true,
  });
  /** @param {any} node */
  const walk = (node) => {
    for (const child of node.children || []) {
      if (
        child.type === "tag" ||
        child.type === "script" ||
        child.type === "style"
      ) {
        callback(toXmlElement(child, starts));
      }
      walk(child);
    }
  };
  walk(doc);
}

/**
 * Adapt an htmlparser2 element node to the HtmlElement shape.
 * @param {any} node @param {number[]} starts @returns {import("./html-parse.js").HtmlElement}
 */
function toXmlElement(node, starts) {
  // Attribute names are NOT lowercased: XML is case-sensitive, so `SRC` is a different
  // attribute from `src` and the browser reads them that way. Folding the case here
  // collapsed the two onto one key and let the last one win, so a decoy `SRC="local.js"`
  // hid a real remote `src`, and a `Src=` on an inline script made us skip a body the
  // browser runs. The HTML path lowercases because HTML does.
  const attrs = new Map(Object.entries(node.attribs || {}));
  const line = lineAt(starts, node.startIndex ?? 0);
  // The whole body, not its first fragment. In XML a <script> is an ordinary element,
  // so its content is a LIST of nodes - text, CDATA sections, comments - and the usual
  // `<script>` newline `<![CDATA[ ... ]]>` shape puts whitespace first. Reading only the
  // first text node returned that whitespace, so every body written that way looked
  // empty. Joining them gives what parse5's single rawtext node gives on the HTML side.
  const pieces = [];
  let startIndex = null;
  for (const child of node.children || []) {
    const parts = child.type === "cdata" ? child.children || [] : [child];
    for (const part of parts) {
      if (part.type !== "text" || typeof part.data !== "string") {
        continue;
      }
      pieces.push(part.data);
      if (startIndex === null && part.data.trim()) {
        startIndex = part.startIndex ?? child.startIndex ?? null;
      }
    }
  }
  return {
    tag: String(node.name).toLowerCase(),
    attr: (name) => (attrs.has(name) ? attrs.get(name) : null),
    attrList: [...attrs].map(([name, value]) => ({ name, value, line })),
    line,
    rawText: pieces.length
      ? {
          value: pieces.join(""),
          startLine: lineAt(starts, startIndex ?? node.startIndex ?? 0),
        }
      : null,
  };
}

/**
 * visibleText for an XML document. Same rule: every text node except the contents of
 * a rawtext element, whose text is code rather than user-facing copy.
 * @param {string} html @returns {string}
 */
function xmlVisibleText(html) {
  const doc = parseDocument(html, { xmlMode: true });
  const parts = [];
  /** @param {any} node */
  const walk = (node) => {
    for (const child of node.children || []) {
      const tag = child.name ? String(child.name).toLowerCase() : null;
      if (tag === "script" || tag === "style") {
        continue;
      }
      if (child.type === "cdata") {
        for (const inner of child.children || []) {
          if (inner.type === "text" && typeof inner.data === "string") {
            parts.push(inner.data);
          }
        }
        continue;
      }
      if (child.type === "text" && typeof child.data === "string") {
        parts.push(child.data);
      }
      walk(child);
    }
  };
  walk(doc);
  return parts.join(" ");
}
