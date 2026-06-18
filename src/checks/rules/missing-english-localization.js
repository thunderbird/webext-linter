// Deterministic check: an add-on whose user-facing text is not English. The
// pre-flight reads the _locales/<dir> set from ctx.addon.files:
//   - uses _locales with an English directory (en, en-US, ...) -> pass.
//   - uses _locales but has no English directory -> a finding.
//   - no _locales at all -> language-detect the hardcoded user-facing text
//     (HTML visible text + manifest name/description) with franc: confident
//     English passes, confident non-English is a finding, and too little or
//     ambiguous text escalates to manual review (the orchestrator routes a
//     deterministic check's escalation straight to a manual note, no LLM).
//
// Belongs here: collecting the _locales set, gathering the user-facing text, and
// turning a franc verdict into pass / finding / manual escalation. Does NOT
// belong here: the visible-text extraction (-> src/scan/html-parse.js), the
// deterministic->manual routing of the escalation (-> src/checks/registry.js +
// escalation.js), authored wording (-> assets/registry.yaml), and severity
// (-> that registry entry, stamped by runChecks).

import { francAll } from "franc-min";
import { finding } from "../../report/finding.js";
import { visibleText } from "../../scan/html-parse.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../../addon/load.js").Addon} Addon */

const ENGLISH_DIR = /^en([-_]|$)/i;
const HTML_FILE = /\.x?html?$/i;
// franc is unreliable on short samples, so below this many characters of
// user-facing text we do not trust a non-English verdict and defer to a human.
const MIN_CONFIDENT = 40;
// franc-all scores the top language 1 and the rest relative to it. When English
// scores this close to a non-English top language, the call is too close to flag.
const NEAR_TIE = 0.9;

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[],
   *   escalations: import("../escalation.js").Escalation[]}}
   */
  run(ctx) {
    const files = ctx.addon?.files;
    if (!files) {
      ctx.note?.("manifest.json", null, "no files", "skipped");
      return { findings: [], escalations: [] };
    }
    const localeDirs = new Set(
      [...files.keys()]
        .filter((p) => p.startsWith("_locales/"))
        .map((p) => p.split("/")[1])
        .filter(Boolean)
    );

    // No _locales: the text is hardcoded, so detect its language directly.
    if (localeDirs.size === 0) {
      return detectHardcodedLanguage(ctx);
    }

    // Uses _locales: an English locale is required - resolved deterministically.
    const english = [...localeDirs].find((d) => ENGLISH_DIR.test(d));
    if (english) {
      ctx.note?.(
        "manifest.json",
        null,
        `English locale present (_locales/${english})`,
        "pass"
      );
      return { findings: [], escalations: [] };
    }
    ctx.note?.(
      "manifest.json",
      null,
      "_locales has no English directory",
      "fail"
    );
    return {
      findings: [finding({ file: "manifest.json" })],
      escalations: [],
    };
  },
};

/**
 * Language-detect the add-on's hardcoded user-facing text and map the result to
 * pass / finding / manual escalation.
 * @param {RunContext} ctx
 * @returns {{findings: import("../../report/finding.js").Finding[],
 *   escalations: import("../escalation.js").Escalation[]}}
 */
function detectHardcodedLanguage(ctx) {
  const text = userFacingText(ctx.addon);
  const note = (msg, verdict) =>
    ctx.note?.("manifest.json", null, msg, verdict);
  if (!text) {
    note("no user-facing text to localize", "pass");
    return { findings: [], escalations: [] };
  }

  const ranked = francAll(text);
  const [topLang] = ranked[0] ?? ["und"];
  const engScore = ranked.find(([code]) => code === "eng")?.[1] ?? 0;

  // Too little text, or franc cannot tell - a human decides (manual review).
  if (text.length < MIN_CONFIDENT || topLang === "und") {
    note("too little user-facing text to detect a language", "unsure");
    return { findings: [], escalations: [{ item: null }] };
  }
  if (topLang === "eng") {
    note("user-facing text is English", "pass");
    return { findings: [], escalations: [] };
  }
  // A non-English top language, but English nearly ties it - too close to flag.
  if (engScore >= NEAR_TIE) {
    note(
      `user-facing text language is ambiguous (${topLang} vs English)`,
      "unsure"
    );
    return { findings: [], escalations: [{ item: null }] };
  }
  note(`non-English user-facing text (${topLang})`, "fail");
  return {
    findings: [finding({ file: "manifest.json" })],
    escalations: [],
  };
}

/**
 * The add-on's user-facing text: the manifest name and description plus the
 * visible text of every packaged HTML document, whitespace-collapsed. The
 * franc input - excludes JS (string literals are noise) and binary assets.
 * @param {Addon} addon
 * @returns {string}
 */
function userFacingText(addon) {
  const parts = [];
  const manifest = addon.manifest;
  if (typeof manifest?.name === "string") {
    parts.push(manifest.name);
  }
  if (typeof manifest?.description === "string") {
    parts.push(manifest.description);
  }
  for (const [path, buf] of addon.files) {
    if (HTML_FILE.test(path)) {
      parts.push(visibleText(buf.toString("utf8")));
    }
  }
  // Drop __MSG_*__ i18n placeholders so they do not skew detection.
  return parts
    .join(" ")
    .replace(/__MSG_[A-Za-z0-9_@]+__/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
