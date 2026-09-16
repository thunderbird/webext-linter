// Every remote-load site in the add-on, gathered once and shared: the refs in HTML,
// the url()/@import in CSS (in a .css file and inside a page), the import() /
// importScripts() / injected-<script> hits in JS, and the manifest CSP's remote script
// hosts. Two checks read this one result - remote-resources (what the developer ships)
// and vendored-remote-resources (what an upstream release ships) - so the walk happens
// once per review, the same "compute once, checks read it" pattern as
// addon.evalScan / addon.outboundSinks.
//
// The scan CLASSIFIES and records; it does not report. Each site carries the text the
// Activity feed narrates it with, and the owning check emits the note - so the feed
// attributes a site to the check that acts on it, rather than to whichever check
// happened to trigger the shared walk first.
//
// Belongs here: sorting each scanned ref into definite / undecidable / upstream /
// cleared, and the CSP hosts. Does NOT belong here: the scanners themselves - HTML refs
// (-> src/scan/html.js), CSS refs (-> src/scan/css.js), JS hits (-> src/parse/
// remote-js.js), CSP hosts (-> src/scan/csp.js) - nor the verdicts, the wording, or the
// escalation routing (-> the two checks + assets/registry.yaml).

import { scanHtmlRemoteRefs, scanHtmlInlineCssRefs } from "../scan/html.js";
import { scanCssRemoteRefs } from "../scan/css.js";
import { remoteJsOf } from "../checks/extract.js";
import { analyzeCsp } from "../scan/csp.js";
import { nonAuthoredJs } from "./bundled.js";
import { verifiedVendorSource } from "../vendor/resolve.js";
import { trunc } from "./util.js";
import { extname, HTML_EXTENSIONS } from "../util/files.js";

/** @typedef {import("../checks/registry.js").RunContext} RunContext */

/**
 * @typedef {object} RemoteSite  One scanned load site, classified.
 * @property {string} file
 * @property {{line: number, column: number}} loc
 * @property {?string} url  The destination AS WRITTEN, whole (never truncated - it is
 *   the fact a judgement turns on). Null where the site names none.
 * @property {?string} upstream  The matched release URL, on an `upstream` site only.
 * @property {string} note  How the Activity feed narrates this site (may be truncated).
 */

/**
 * @typedef {object} RemoteRefs
 * @property {RemoteSite[]} definite  A resolvable remote load in the developer's own
 *   code: nothing to decide, the add-on must bundle it.
 * @property {RemoteSite[]} undecidable  The scan cannot tell whether it is remote (a
 *   non-literal URL, an inline data:/blob: script source) - a reader of the code can.
 * @property {RemoteSite[]} upstream  A remote load inside a file whose CONTENT matched a
 *   published upstream release, so the line is that release's, not the developer's.
 * @property {RemoteSite[]} cleared  A bundled script/frame load - benign, but narrated:
 *   it is on the trail of "what runs".
 * @property {string[]} cspHosts  Remote script hosts the manifest CSP permits.
 */

/**
 * The shared scan, computed once per addon.
 * @param {RunContext} ctx
 * @returns {RemoteRefs}
 */
export function getRemoteRefs(ctx) {
  return (ctx.addon.remoteRefs ??= scan(ctx));
}

/**
 * @param {RunContext} ctx
 * @returns {RemoteRefs}
 */
function scan(ctx) {
  const { addon } = ctx;
  const out = {
    definite: [],
    undecidable: [],
    upstream: [],
    cleared: [],
    cspHosts: [],
  };

  for (const [file, buf] of addon.files) {
    const ext = extname(file);
    if (HTML_EXTENSIONS.has(ext)) {
      // Resolved once per file, not per ref: every ref below is judged against the
      // same answer, so a file cannot be upstream's for one ref and the developer's
      // for the next.
      const release = verifiedVendorSource(addon, file);
      const html = buf.toString("utf8");
      for (const ref of scanHtmlRemoteRefs(html)) {
        sortHtml(out, file, ref, release);
      }
      // CSS inside the HTML (<style> blocks, style= attrs) goes through the same
      // css.js scanner as a .css file, so a remote @import/url() there is not missed.
      for (const ref of scanHtmlInlineCssRefs(html)) {
        sortCss(out, file, ref, release);
      }
    } else if (ext === ".css") {
      const release = verifiedVendorSource(addon, file);
      for (const ref of scanCssRemoteRefs(buf.toString("utf8"))) {
        sortCss(out, file, ref, release);
      }
    }
  }

  // Skip non-authored JS (see nonAuthoredJs). A vendored .js is in that set, so this
  // lane DROPS it - silently, with no site recorded at all - and a remote load inside
  // a verified vendored .js is never surfaced. The HTML/CSS lanes above do not follow
  // that rule: they ask verifiedVendorSource per file and record the site as
  // upstream's instead of dropping it. Remote refs in HTML/CSS and the CSP hosts below
  // therefore still apply, and nothing skips a vendored .html/.css.
  const skip = nonAuthoredJs(ctx);
  for (const src of ctx.jsSources ?? []) {
    if (skip.has(src.file)) {
      continue;
    }
    for (const hit of remoteJsOf(src).hits) {
      sortJs(out, src.file, hit);
    }
  }

  out.cspHosts = analyzeCsp(ctx.manifest).remoteHosts;
  return out;
}

/**
 * @param {RemoteRefs} out @param {string} file
 * @param {object} ref  An html.js remote ref.
 * @param {?string} release  Set when this file is a verified vendored copy.
 */
function sortHtml(out, file, ref, release) {
  const { tag, kind, url, klass, line } = ref;
  const loc = { line, column: 0 };
  const note = `<${tag}> ${trunc(url)}`;
  const undecidable = klass.embedded && kind.script;
  if (release && (klass.remote || undecidable)) {
    // Upstream's own line, whether or not we could resolve where it points: the
    // undecidable ones go here too, because resolving one could only turn it into a
    // finding this file is exempt from.
    out.upstream.push({ file, loc, url, upstream: release, note });
  } else if (klass.remote) {
    out.definite.push({ file, loc, url, upstream: null, note });
  } else if (undecidable) {
    out.undecidable.push({ file, loc, url: null, upstream: null, note });
  } else if (klass.local && (kind.script || kind.content)) {
    out.cleared.push({ file, loc, url, upstream: null, note });
  }
}

/**
 * @param {RemoteRefs} out @param {string} file
 * @param {object} ref  A css.js remote ref.
 * @param {?string} release  Set when this file is a verified vendored copy.
 */
function sortCss(out, file, ref, release) {
  const { url, klass, line } = ref;
  if (!klass.remote) {
    return; // local CSS url()/imports are bundled assets - benign, not narrated
  }
  const loc = { line, column: 0 };
  const note = `css ${trunc(url)}`;
  const site = { file, loc, url, upstream: release ?? null, note };
  (release ? out.upstream : out.definite).push(site);
}

// Remote-JS hit types that are definite remote loads (vs the undecidable ones, which
// carry no resolvable URL and are left for a reader of the code).
const REMOTE_JS = new Set([
  "remote-import",
  "remote-importscripts",
  "remote-script-src",
  "remote-script-html",
  "remote-wasm",
]);

// What each undecidable hit does, for the escalation evidence line.
const UNDECIDABLE_JS = {
  "embedded-script-src": "sets a <script> src to an inline data:/blob: URL",
  "ambiguous-import": "calls dynamic import() with a non-literal URL",
  "ambiguous-importscripts": "calls importScripts() with a non-literal URL",
  "ambiguous-script-src":
    "sets a <script> element's src from a non-literal value",
};

/**
 * @param {RemoteRefs} out @param {string} file
 * @param {object} hit  A remote-js.js hit.
 */
function sortJs(out, file, hit) {
  const loc = { line: hit.line, column: hit.column };
  if (REMOTE_JS.has(hit.type)) {
    out.definite.push({
      file,
      loc,
      url: hit.url ?? null,
      upstream: null,
      note: `${hit.type}${hit.url ? ` ${trunc(hit.url)}` : ""}`,
    });
  } else if (UNDECIDABLE_JS[hit.type]) {
    out.undecidable.push({
      file,
      loc,
      url: null,
      upstream: null,
      note: UNDECIDABLE_JS[hit.type],
    });
  }
}
