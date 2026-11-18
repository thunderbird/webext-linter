// Rejects a source-code submission whose .npmrc or bunfig.toml SETS a package registry.
// npm, pnpm and Bun read .npmrc for `registry=` (the default) and `@scope:registry=` (per
// scope), and Bun also reads bunfig.toml for `install.registry` and `install.scopes`; a legitimate
// build never needs to set either (npm already defaults to the public registry), so ANY
// registry setting is disallowed outright - it can only point the install at a source
// other than the public npm registry, pulling the SAME declared package names from an
// UNDECLARED source and leaving package.json/lock a clean decoy. The file is read with
// npm's own parser (`ini`), so a quoted key counts and a key under a [section], which npm
// ignores, does not. The value is NOT judged: the mere presence of the key is the reject.
// Deterministic, no network.
//
// input: sca - reads the submitted source archive off ctx.artifact. The package root's
// .npmrc and bunfig.toml are the ones read: npm and Bun take their config from the directory
// the install runs in, and the review runs it at --sca-package-root, so those are the files
// whose settings reach the install. A
// config deeper in the tree belongs to a directory this review never installs from, so it is
// never asked for: this reads that one key and never scans for others.
//
// bunfig.toml is read with a TOML parser (smol-toml), so every spelling Bun reads as the same
// key counts: a dotted key, an inline table, a quoted or escaped key ("regis\u0074ry"). Bun
// refuses a bunfig.toml it cannot parse, but two parsers can disagree at the edges, so one
// this cannot parse is reported too rather than passed unread.
//
// Belongs here: flagging .npmrc and bunfig.toml registry settings. Does NOT belong here: which files are
// in the source view (-> src/addon/load.js scaViews) or the wording (-> the registry).

import ini from "ini";
import { parse as parseToml } from "smol-toml";

import { VERDICT } from "../../lib/enum.js";
import { rethrowIfFatal } from "../../lib/errors.js";
import { finding } from "../../report/finding.js";
import { packageRootKey, submissionFiles } from "../../vendor/package-file.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const files = submissionFiles(ctx.artifact);
    const findings = [];
    for (const [file, read] of [
      [".npmrc", registrySettings],
      ["bunfig.toml", bunRegistrySettings],
    ]) {
      const buf = files?.get(file);
      if (!buf) {
        continue;
      }
      for (const { line, value } of read(buf.toString("utf8"))) {
        const at = ctx.artifact.at(packageRootKey(ctx.artifact, file), {
          line,
        });
        ctx.note?.(at, "sets a package registry", VERDICT.FAIL);
        findings.push(finding({ ...at, item: value }));
      }
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
 * Every package registry a bunfig.toml sets, as Bun reads it: `install.registry` (a URL, or a
 * table naming one) and each scope of `install.scopes`, with the line it is set on. A file
 * that does not parse is reported whole, at line 1: what cannot be read cannot be shown to
 * set no registry. The TOML parser reports no positions, so a setting is anchored at the
 * first line naming its URL, or at line 1.
 * @param {string} text
 * @returns {{line: number, value: string}[]}
 */
function bunRegistrySettings(text) {
  let config;
  try {
    config = parseToml(text);
  } catch (err) {
    rethrowIfFatal(err);
    return [{ line: 1, value: "bunfig.toml (cannot be parsed)" }];
  }
  const lines = text.split(/\r?\n/);
  const settings = [];
  // A registry is named by its URL, or by its key where it gives none.
  const add = (setting, key, prefix = "") => {
    const url = String(
      (isSection(setting) ? setting.url : setting) ?? ""
    ).trim();
    const line = url ? lines.findIndex((l) => l.includes(url)) + 1 : 0;
    settings.push({ line: line || 1, value: prefix + (url || key) });
  };
  const install = isSection(config.install) ? config.install : {};
  if (Object.hasOwn(install, "registry")) {
    add(install.registry, "install.registry");
  }
  if (Object.hasOwn(install, "scopes")) {
    const scopes = isSection(install.scopes) ? install.scopes : {};
    if (!Object.keys(scopes).length) {
      add("", "install.scopes");
    }
    for (const [scope, setting] of Object.entries(scopes)) {
      add(setting, `install.scopes.${scope}`, `${scope}: `);
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
