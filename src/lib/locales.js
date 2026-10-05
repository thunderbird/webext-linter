// The add-on's _locales state, scanned once and shared. The
// default-locale-missing, default-locale-unused and trademark checks read these
// results (missing-english-localization takes isEnglishLocale only), so each file
// scan runs a single time per review - the same "compute
// once, checks read it" pattern as addon.outboundSinks / addon.bundled.
//
// Belongs here: localeMessages - each _locales/<lang> folder and its messages.json, read
// the way Thunderbird reads them; localeKey - the key Thunderbird files a locale under;
// localizedNames - the name each locale states, resolved through a __MSG_ placeholder,
// plus the locales whose file could not be read; isEnglishLocale - reading a locale
// folder's tag; and memoizing both scans on ctx.cache.
//
// Does NOT belong here: the verdicts (-> src/checks/rules/default-locale-*.js
// and the trademark-* checks), the English-localization judgement (->
// missing-english-localization.js, which computes the same dir set inline and
// could later adopt this helper), and the authored wording (->
// assets/registry.yaml).

import { parseExtensionJson } from "../util/json.js";

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
 * Every locale directory's messages.json, read the way Thunderbird reads it, scanned once
 * and memoized. Thunderbird reads EVERY directory under _locales at install and refuses the
 * add-on when one has no messages.json, one it cannot read, or one that is not messages
 * data (an object of entries, each an object with a string `message`) - so each directory
 * is answered: `ok` with its parse, `missing`, `unreadable` or `invalid`.
 *
 * A directory is any `_locales/<dir>/` the package holds, an empty one included (the walk
 * records directories the file keys cannot show, a packed one's directory entries too); a
 * file sitting directly in _locales is not one. Thunderbird keys a locale by its tag with
 * `_` read as `-`, and reads ONE directory per key, so where `en_US` and `en-US` both exist
 * and one of them is fine, the other is not reported: which one Thunderbird reads depends on
 * the order it lists them.
 * @param {RunContext} ctx
 * @returns {{locale: string, file: string, state: "ok"|"missing"|"unreadable",
 *   json?: *}[]}
 */
export function localeMessages(ctx) {
  return ((ctx.cache ??= {}).localeMessages ??= scanMessages(ctx));
}

/**
 * @param {RunContext} ctx
 * @returns {ReturnType<typeof localeMessages>}
 */
function scanMessages(ctx) {
  const files = ctx.artifact.files;
  const dirs = new Set();
  const note = (path) => {
    const parts = path.split("/");
    if (parts[0] === "_locales" && parts[1] && parts.length >= 3) {
      dirs.add(parts[1]);
    }
  };
  for (const path of files.keys()) {
    note(path);
  }
  for (const dir of ctx.artifact.directories) {
    note(`${dir}/`);
  }
  const read = [...dirs].sort().map((locale) => {
    const file = `_locales/${locale}/messages.json`;
    if (!files.has(file)) {
      return { locale, file, state: "missing" };
    }
    const json = parseExtensionJson(files.get(file));
    if (json === undefined) {
      return { locale, file, state: "unreadable" };
    }
    return isMessagesData(json)
      ? { locale, file, state: "ok", json }
      : { locale, file, state: "invalid" };
  });
  const fineKeys = new Set(
    read.filter((r) => r.state === "ok").map((r) => localeKey(r.locale))
  );
  return read.filter(
    (r) => r.state === "ok" || !fineKeys.has(localeKey(r.locale))
  );
}

/**
 * The key Thunderbird files a locale under: its tag with `_` read as `-` (Gecko's
 * normalizeLocaleCode), so `en_US` and `en-US` name one locale.
 * @param {string} tag @returns {string}
 */
export function localeKey(tag) {
  return tag.split("_").join("-");
}

/**
 * Whether a parse is messages data as Thunderbird accepts it (LocaleData.addLocale): a plain
 * object whose every entry is a plain object with a string `message`.
 * @param {*} json @returns {boolean}
 */
function isMessagesData(json) {
  const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  return (
    plain(json) &&
    Object.values(json).every((m) => plain(m) && typeof m.message === "string")
  );
}

/**
 * The name each locale states, scanned once and memoized on the addon so every
 * trademark check shares the result.
 *
 * A literal manifest.json name yields ONE pair carrying `locale: null` - the package
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
 * pass on silence. The file itself is locale-messages-invalid's finding.
 *
 * The name comes from ctx.manifest.json (always the shipped one) and the locale files
 * from ctx.artifact.files (the routed artifact), so this is only meaningful for a
 * check declaring `input: xpi`: a source-input caller would resolve the shipped
 * placeholder against the source tree's locale files.
 * @param {RunContext} ctx
 * @returns {{pairs: LocalizedName[], resolved: boolean, localized: boolean,
 *   unreadable: string[]}}
 */
export function localizedNames(ctx) {
  return ((ctx.cache ??= {}).localizedNames ??= scanNames(ctx));
}

/**
 * @param {RunContext} ctx
 * @returns {{pairs: LocalizedName[], resolved: boolean, localized: boolean,
 *   unreadable: string[]}}
 */
function scanNames(ctx) {
  const name = ctx.manifest?.json?.name;
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
  for (const { locale, state, json } of localeMessages(ctx)) {
    if (state === "unreadable") {
      unreadable.push(locale);
    }
    const value = json?.[key]?.message;
    if (typeof value === "string") {
      pairs.push({ locale, name: value });
    }
  }
  return { pairs, resolved: pairs.length > 0, localized: true, unreadable };
}
