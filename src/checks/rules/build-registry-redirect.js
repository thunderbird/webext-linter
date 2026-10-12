// Rejects a source-code submission whose .npmrc SETS a package registry. npm/pnpm read
// .npmrc for `registry=` (the default) and `@scope:registry=` (per scope); a legitimate
// build never needs to set either (npm already defaults to the public registry), so ANY
// registry setting is disallowed outright - it can only point the install at a source
// other than the public npm registry, pulling the SAME declared package names from an
// UNDECLARED source and leaving package.json/lock a clean decoy. The file is read with
// npm's own parser (`ini`), so a quoted key counts and a key under a [section], which npm
// ignores, does not. The value is NOT judged: the mere presence of the key is the reject.
// Deterministic, no network.
//
// input: sca - reads the submitted source archive off ctx.artifact. The ARCHIVE'S OWN .npmrc is the
// one read: npm takes its config from the directory the install runs in, and the review
// runs it at --sca-root, so that is the file whose settings reach the install. A config
// deeper in the tree belongs to a directory this review never installs from, so it is never
// asked for: this reads the one root key and never scans for others.
//
// Belongs here: flagging .npmrc registry settings. Does NOT belong here: which files are
// in the source view (-> src/addon/load.js scaViews) or the wording (-> the registry).

import ini from "ini";

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const buf = ctx.artifact.files.get(".npmrc");
    if (!buf) {
      return { findings: [] };
    }
    const findings = [];
    for (const { line, value } of registrySettings(buf.toString("utf8"))) {
      const at = ctx.artifact.at(".npmrc", { line });
      ctx.note?.(at, "sets a package registry", VERDICT.FAIL);
      findings.push(finding({ ...at, item: value }));
    }
    return { findings };
  },
};

/**
 * Every package registry the .npmrc sets, as npm reads the file (`ini.decode`): a
 * top-level `registry` or `@scope:registry` key, matched case-insensitively, with the
 * line it is set on. A key under a [section] decodes into that section and is not one
 * npm uses. The value is not validated - ANY registry setting is rejected - and an empty
 * one is reported by its key, so a finding always has a subject.
 *
 * `ini` reports no positions, so the line is the first line at which decoding the file up
 * to and including it yields the key. The same parser decides both, on a file small enough
 * to decode once per line.
 * @param {string} text
 * @returns {{line: number, value: string}[]}
 */
function registrySettings(text) {
  const settings = [];
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const decoded = ini.decode(lines.slice(0, i + 1).join("\n"));
    for (const [key, value] of Object.entries(decoded)) {
      if (seen.has(key) || !isRegistryKey(key) || isSection(value)) {
        continue;
      }
      seen.add(key);
      for (const one of [value].flat()) {
        settings.push({ line: i + 1, value: String(one ?? "").trim() || key });
      }
    }
  }
  return settings;
}

/**
 * Whether a decoded top-level key sets a registry: `registry` itself, or one scope's
 * `@scope:registry`.
 * @param {string} key
 * @returns {boolean}
 */
function isRegistryKey(key) {
  const k = key.toLowerCase();
  return (
    k === "registry" ||
    (k.startsWith("@") &&
      k.endsWith(":registry") &&
      k.indexOf(":") === k.length - ":registry".length)
  );
}

/**
 * Whether a decoded value is a [section]: an object that is not an array.
 * @param {unknown} value
 * @returns {boolean}
 */
function isSection(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
