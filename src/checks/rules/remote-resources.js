// LLM check: the add-on must bundle everything it loads. The deterministic
// pre-flight flags the definite remote loads - <script>/<link>/<iframe>/media in
// HTML, @import/url() in CSS, import()/importScripts()/module imports, runtime
// <script> injection, remote WASM, and a content_security_policy that permits a
// remote script source. Statically-undecidable cases (non-literal URLs, inline
// data:/blob: script sources) are escalated, carrying the offending file so the
// orchestrator can ask the LLM whether the source is remote (else manual
// review). A ref inside a file whose content matched a published upstream release
// is neither: it is that release's own line, so it goes to a reviewer and never to
// the model (see pushVendored). Two limits worth knowing: only the
// shipped XPI carries verified results (verifyVendor runs on it alone), so an SCA
// review never reaches that lane; and the JS lane below never does either, because
// a vendored .js is dropped from it entirely.
//
// Belongs here: classifying each scanned ref as definite-remote (-> finding),
// undecidable (-> escalation with file evidence) or upstream's (-> escalation a
// model cannot help with) across HTML, CSS, JS, and CSP.
// Does NOT belong here: the scanners themselves - HTML refs (-> src/scan/
// html.js), CSS refs (-> src/scan/css.js), JS import/inject hits (-> src/parse/
// remote-js.js), CSP hosts (-> src/scan/csp.js) - the LLM-or-manual verdict on
// escalations (-> src/checks/escalation.js), missing local files (->
// bundled-files.js), authored wording (-> assets/registry.yaml), severity
// (-> that registry entry, stamped by src/checks/registry.js), and report
// formatting (-> src/report/format.js).

import { VERDICT } from "../../lib/enum.js";
import { scanHtmlRemoteRefs, scanHtmlInlineCssRefs } from "../../scan/html.js";
import { scanCssRemoteRefs } from "../../scan/css.js";
import { remoteJsOf } from "../extract.js";
import { analyzeCsp } from "../../scan/csp.js";
import { nonAuthoredJs } from "../../lib/bundled.js";
import { verifiedVendorSource } from "../../vendor/resolve.js";
import { dedupe, scheme, trunc } from "../../lib/util.js";
import { perCandidateResolve } from "../../lib/verdict-resolve.js";
import { finding } from "../../report/finding.js";
import { extname, HTML_EXTENSIONS } from "../../util/files.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../../scan/html.js").HtmlRef} HtmlRef */
/** @typedef {import("../../scan/css.js").CssRef} CssRef */
/** @typedef {import("../../parse/remote-js.js").RemoteJsHit} RemoteJsHit */
/** @typedef {import("../escalation.js").Escalation} Escalation */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[],
   *   llm?: import("../escalation.js").LlmStep, escalations?: Escalation[]}}
   */
  run(ctx) {
    const { addon } = ctx;
    const findings = [];
    // Collector for the undecidable sites: one candidate + 1:1 case per site.
    const esc = { candidates: [], cases: [], n: 0 };
    // Sites in a file matched against upstream, which no model can help with
    // (see pushVendored).
    const forHumans = [];

    for (const [file, buf] of addon.files) {
      const ext = extname(file);
      if (HTML_EXTENSIONS.has(ext)) {
        // Resolved once per file, not per ref: every ref below is judged against
        // the same answer, so a file cannot be upstream's for one ref and the
        // developer's for the next.
        const upstream = verifiedVendorSource(addon, file);
        const html = buf.toString("utf8");
        for (const ref of scanHtmlRemoteRefs(html)) {
          pushHtml(ctx, findings, esc, forHumans, file, ref, upstream);
        }
        // CSS inside the HTML (<style> blocks, style= attrs) is scanned with the
        // same css.js scanner as a .css file, so a remote @import/url() there is
        // not missed.
        for (const ref of scanHtmlInlineCssRefs(html)) {
          pushCss(ctx, findings, forHumans, file, ref, upstream);
        }
      } else if (ext === ".css") {
        const upstream = verifiedVendorSource(addon, file);
        for (const ref of scanCssRemoteRefs(buf.toString("utf8"))) {
          pushCss(ctx, findings, forHumans, file, ref, upstream);
        }
      }
    }

    // Skip non-authored JS (see nonAuthoredJs). A vendored .js is in that set, so
    // this lane DROPS it - silently, with no finding and no escalation. That is not
    // the rule the HTML/CSS lanes above follow, and the asymmetry is deliberate
    // only in that the vendored JS skip is declaration-based by an earlier call; a
    // remote load inside a verified vendored .js is therefore never surfaced.
    // Remote refs in HTML/CSS and the CSP check below still apply - those are not
    // per-file JS scans, and nothing skips a vendored .html/.css.
    const skip = nonAuthoredJs(ctx);
    for (const src of ctx.jsSources) {
      if (skip.has(src.file)) {
        continue;
      }
      const { hits } = remoteJsOf(src);
      for (const hit of hits) {
        pushJs(ctx, findings, esc, src.file, hit);
      }
    }

    for (const host of analyzeCsp(ctx.manifest).remoteHosts) {
      findings.push(finding({ file: "manifest.json", item: host }));
      ctx.note?.("manifest.json", null, `CSP script-src ${host}`, VERDICT.FAIL);
    }

    const result = { findings: dedupe(findings) };
    if (esc.candidates.length) {
      result.llm = {
        candidates: esc.candidates,
        resolve: perCandidateResolve(esc.cases),
      };
    }
    if (forHumans.length) {
      // Deduped like the findings above: the scanners can report one site twice
      // (see dedupe), and a reviewer should be asked once.
      result.escalations = dedupe(forHumans);
    }
    return result;
  },
};

/**
 * Record one undecidable site as an LLM candidate (file:line, with the construct
 * `note`) plus its 1:1 case (a `fail` verdict becomes a finding at that site).
 * @param {{candidates: object[], cases: object[], n: number}} esc
 * @param {string} file
 * @param {number} line
 * @param {{line: number, column: number}} loc
 * @param {string} note  What the site does (the construct description).
 */
function addCandidate(esc, file, line, loc, note) {
  const id = `R${++esc.n}`;
  esc.candidates.push({ id, file, line, note, corpus: [file] });
  // The undecidable site carries no resolvable URL, so its finding shows only the
  // locus (file:line); the response/instructions wording is generic (no {{item}}).
  esc.cases.push({ id, finding: { file, loc } });
}

/**
 * Record one site whose containing file matched a published upstream release as a
 * escalation no model can help with. The line is that release's own, so what it
 * does is not the developer's choice to defend - but nor does it follow that the
 * developer NEEDS this file or could not ship a build without it
 * (verifiedVendorSource states a fact about content, not about intent). Whether the
 * check knows where the load points or not, a model verdict on that question would
 * not change the outcome, so the case is marked `llmNotNeeded: true` (which
 * registry.rechecks honours) and the report gives the reviewer both URLs.
 *
 * This turns on the content match, not on the declaration: a declared file that
 * could not be verified is reviewed as the developer's own code
 * (applyUnverifiedVendor), so its remote loads stay findings.
 * @param {RunContext} ctx
 * @param {Escalation[]} forHumans
 * @param {string} file @param {{line: number, column: number}} loc
 * @param {string} url  Where the site loads from. Passed WHOLE - it is the fact the
 *   judgement turns on, so it must not reach the report truncated the way the feed
 *   note below is.
 * @param {string} upstream  The matched release URL (shown per locus as the hint).
 * @param {string} note  The site as the Activity feed narrates it.
 */
function pushVendored(ctx, forHumans, file, loc, url, upstream, note) {
  forHumans.push({
    item: url,
    file,
    loc,
    llmNotNeeded: true,
    // The upstream goes in the HINT, not a wording slot: it is per-locus detail,
    // so every such site stays in ONE manual-review group and each line still says
    // which release it was matched against.
    hint: upstream,
  });
  // INFO, not UNSURE: nothing here is uncertain in the way the undecidable sites
  // below are - the check reached a verdict and is recording it rather than acting
  // on it. Same nature as an info finding; only the destination differs, and where
  // an item lands is not what this tag narrates.
  ctx.note?.(file, loc, note, VERDICT.INFO);
}

/**
 * @param {RunContext} ctx
 * @param {import("../../report/finding.js").Finding[]} findings
 * @param {{candidates: object[], cases: object[], n: number}} esc
 * @param {Escalation[]} forHumans
 * @param {string} file
 * @param {HtmlRef} ref
 * @param {?string} upstream  Set when this file is a verified vendored copy.
 */
function pushHtml(ctx, findings, esc, forHumans, file, ref, upstream) {
  const { tag, kind, url, klass, line } = ref;
  const loc = { line, column: 0 };
  const item = `<${tag}> ${trunc(url)}`;
  const undecidable = klass.embedded && kind.script;
  if (upstream && (klass.remote || undecidable)) {
    // Upstream's own line, whether or not we could resolve where it points: the
    // undecidable ones go here too, because a model verdict could only turn one
    // into a finding this file is exempt from.
    pushVendored(ctx, forHumans, file, loc, url, upstream, item);
  } else if (klass.remote) {
    findings.push(finding({ file, loc, item: url }));
    ctx.note?.(file, loc, item, VERDICT.FAIL);
  } else if (undecidable) {
    addCandidate(
      esc,
      file,
      line,
      loc,
      `has a <script> with an inline ${scheme(url)} URL`
    );
    ctx.note?.(file, loc, item, VERDICT.UNSURE);
  } else if (klass.local && (kind.script || kind.content)) {
    // A bundled script/iframe load - cleared, but on the trail of "what runs".
    ctx.note?.(file, loc, item, VERDICT.PASS);
  }
}

/**
 * @param {RunContext} ctx
 * @param {import("../../report/finding.js").Finding[]} findings
 * @param {Escalation[]} forHumans
 * @param {string} file
 * @param {CssRef} ref
 * @param {?string} upstream  Set when this file is a verified vendored copy.
 */
function pushCss(ctx, findings, forHumans, file, ref, upstream) {
  const { url, klass, line } = ref;
  if (!klass.remote) {
    return; // local CSS url()/imports are bundled assets - benign, not noted
  }
  const loc = { line, column: 0 };
  const item = `css ${trunc(url)}`;
  if (upstream) {
    pushVendored(ctx, forHumans, file, loc, url, upstream, item);
    return;
  }
  findings.push(finding({ file, loc, item: url }));
  ctx.note?.(file, loc, item, VERDICT.FAIL);
}

// Remote-JS hit types that are definite remote loads (vs the undecidable ones,
// which carry no resolvable URL and are escalated for judgement).
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
 * @param {RunContext} ctx
 * @param {import("../../report/finding.js").Finding[]} findings
 * @param {{candidates: object[], cases: object[], n: number}} esc
 * @param {string} file
 * @param {RemoteJsHit} hit
 */
function pushJs(ctx, findings, esc, file, hit) {
  const loc = { line: hit.line, column: hit.column };
  if (REMOTE_JS.has(hit.type)) {
    findings.push(finding({ file, loc, item: hit.url ?? null }));
    ctx.note?.(
      file,
      loc,
      `${hit.type}${hit.url ? ` ${trunc(hit.url)}` : ""}`,
      VERDICT.FAIL
    );
  } else if (UNDECIDABLE_JS[hit.type]) {
    addCandidate(esc, file, hit.line, loc, UNDECIDABLE_JS[hit.type]);
    ctx.note?.(file, loc, UNDECIDABLE_JS[hit.type], VERDICT.UNSURE);
  }
}
