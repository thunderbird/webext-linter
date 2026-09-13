// The add-on's _locales state, scanned once and shared. The
// default-locale-missing, default-locale-unused and trademark checks read these
// results, so each file scan runs a single time per review - the same "compute
// once, checks read it" pattern as addon.outboundSinks / addon.bundled.
//
// Belongs here: getLocales - collecting the _locales/<lang> directories present
// in the package; localizedNames - the name each locale states, resolved through a
// __MSG_ placeholder, plus the locales whose file could not be read;
// isEnglishLocale - reading a locale directory's tag; and memoizing both scans on
// the addon.
//
// Does NOT belong here: the verdicts (-> src/checks/rules/default-locale-*.js
// and the trademark-* checks), the English-localization judgement (->
// missing-english-localization.js, which computes the same dir set inline and
// could later adopt this helper), and the authored wording (->
// assets/registry.yaml).

import { stripBom } from "../util/json.js";

/** @typedef {import("../checks/registry.js").RunContext} RunContext */
/** @typedef {{locale: string|null, name: string}} LocalizedName */

// A locale directory whose tag says English: the bare language, or English with
// any region ("en", "en_US", "en-GB"). The tag is metadata, not a language
// judgement - which is the whole reason a check can rely on it.
const ENGLISH_DIR = /^en([-_]|$)/i;

/**
 * Whether a _locales directory tag names English. A null locale (an unlocalized
 * name) is NOT English: nothing states its language, which is a different answer
 * from "not English" and callers must handle it as such.
 * @param {string|null} tag
 * @returns {boolean}
 */
export function isEnglishLocale(tag) {
  return typeof tag === "string" && ENGLISH_DIR.test(tag);
}

/**
 * The add-on's _locales directories, scanned once and memoized on the addon so
 * every check shares the result.
 * @param {RunContext} ctx
 * @returns {{dirs: Set<string>, hasLocales: boolean}}
 */
export function getLocales(ctx) {
  return (ctx.addon.locales ??= scan(ctx));
}

/**
 * @param {RunContext} ctx
 * @returns {{dirs: Set<string>, hasLocales: boolean}}
 */
function scan(ctx) {
  const dirs = new Set();
  for (const p of ctx.addon?.files?.keys() ?? []) {
    if (p.startsWith("_locales/")) {
      const lang = p.split("/")[1];
      if (lang) {
        dirs.add(lang);
      }
    }
  }
  return { dirs, hasLocales: dirs.size > 0 };
}

/**
 * The name each locale states, scanned once and memoized on the addon so every
 * trademark check shares the result.
 *
 * A literal manifest name yields ONE pair carrying `locale: null` - the package
 * says nothing about its language. A `__MSG_key__` name yields one pair per
 * _locales/<locale>/messages.json that defines the key, each tagged with that
 * directory. That null-vs-tagged split is what lets one check judge a name
 * against its own declared language and another treat an unlabelled name as the
 * open question it is.
 *
 * It reads the name the add-on DECLARES, which is not always the one Thunderbird
 * displays: a message using i18n `placeholders` is taken as written, so the
 * substituted text is not seen. `unreadable` carries every locale whose file could
 * not be parsed and `resolved` is false when the placeholder resolves nowhere -
 * both exist so a caller can report that it could not read the name rather than
 * pass on silence. NOTHING else reports an unparsable locale file, so a caller that
 * drops these is all that stands between such a name and no review at all.
 *
 * The name comes from ctx.manifest (always the shipped one) and the locale files
 * from ctx.addon.files (the routed artifact), so this is only meaningful for a
 * check declaring `input: xpi`: a source-input caller would resolve the shipped
 * placeholder against the source tree's locale files.
 * @param {RunContext} ctx
 * @returns {{pairs: LocalizedName[], resolved: boolean, localized: boolean,
 *   unreadable: string[]}}
 */
export function localizedNames(ctx) {
  return (ctx.addon.localizedNames ??= scanNames(ctx));
}

/**
 * @param {RunContext} ctx
 * @returns {{pairs: LocalizedName[], resolved: boolean, localized: boolean,
 *   unreadable: string[]}}
 */
function scanNames(ctx) {
  const name = ctx.manifest?.name;
  if (typeof name !== "string") {
    return { pairs: [], resolved: false, localized: false, unreadable: [] };
  }
  const key = /^__MSG_(.+)__$/.exec(name)?.[1];
  if (!key) {
    return {
      pairs: [{ locale: null, name }],
      resolved: true,
      localized: false,
      unreadable: [],
    };
  }
  const pairs = [];
  const unreadable = [];
  for (const [path, buf] of ctx.addon?.files ?? []) {
    const locale = /^_locales\/([^/]+)\/messages\.json$/.exec(path)?.[1];
    if (!locale) {
      continue;
    }
    let json;
    try {
      // Thunderbird reads these through a BOM-stripping JSON reader, so a
      // BOM-prefixed file states a name it DISPLAYS. Parsing it strictly would
      // turn a common packaging accident into a name no check ever sees.
      json = JSON.parse(stripBom(buf.toString("utf8")));
    } catch {
      unreadable.push(locale);
      continue;
    }
    const value = json?.[key]?.message;
    if (typeof value === "string") {
      pairs.push({ locale, name: value });
    }
  }
  return { pairs, resolved: pairs.length > 0, localized: true, unreadable };
}
