// Reads the raw annotated-schema JSON files from a zip or a directory and
// returns them parsed. The downloaded codeload zip nests everything under a
// top-level folder (e.g.
// "webext-annotated-schemas-release-mv3/schema-files/*.json"). A directory
// source may point either at the repo root (containing schema-files/) or
// directly at a folder of .json files. We handle all of these so tests can use
// a plain directory fixture.
//
// Belongs here: file reading and JSON parsing - locating schema-files/*.json
// inside a zip or dir, JSON5-parsing each into namespace-object arrays, and
// returning the "<name>.json" -> parsed map. File IO only.
//
// Does NOT belong here: fetching or caching the zip (src/schema/fetch.js),
// merging the parsed fragments or any query logic (src/schema/merge.js and
// src/schema/index.js). The parsed output is handed to buildSchemaIndex.

import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import JSON5 from "json5";
import { debug } from "../util/log.js";

/** @typedef {import("./index.js").SchemaNode} SchemaNode */

/** Matches ".../schema-files/<name>.json" and captures the base name. */
const SCHEMA_ENTRY = /(?:^|\/)schema-files\/([^/]+\.json)$/;

/**
 * @typedef {object} LoadedSchemas
 * @property {Record<string, SchemaNode[]>} files  "<name>.json" -> parsed.
 * @property {string} source  Description of where the schemas came from.
 */

/**
 * Load schema files from a zip path or a directory.
 * @param {string} source  Path to a .zip, a repo dir, or a dir of *.json
 *   schema files.
 * @returns {LoadedSchemas}
 */
export function loadSchemaFiles(source) {
  const stat = fs.statSync(source);
  const files = stat.isDirectory() ? loadFromDir(source) : loadFromZip(source);

  if (Object.keys(files).length === 0) {
    throw new Error(
      `No schema-files/*.json found in ${source}. ` +
        "Expected the annotated-schemas layout (a schema-files/ directory of JSON files)."
    );
  }
  debug(`Loaded ${Object.keys(files).length} schema files from ${source}`);
  return { files, source };
}

/**
 * @param {string} zipPath  Path to the zip archive.
 * @returns {Record<string, SchemaNode[]>} Name -> parsed schema array.
 */
function loadFromZip(zipPath) {
  const zip = new AdmZip(zipPath);
  const files = {};
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }
    const m = entry.entryName.match(SCHEMA_ENTRY);
    if (!m) {
      continue;
    }
    const name = m[1];
    files[name] = parse(name, entry.getData().toString("utf8"));
  }
  return files;
}

/**
 * @param {string} dir  Path to the directory to load schema files from.
 * @returns {Record<string, SchemaNode[]>} Name -> parsed schema array.
 */
function loadFromDir(dir) {
  // Accept either <dir>/schema-files/*.json or <dir>/*.json.
  const schemaDir = fs.existsSync(path.join(dir, "schema-files"))
    ? path.join(dir, "schema-files")
    : dir;
  const files = {};
  for (const name of fs.readdirSync(schemaDir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    files[name] = parse(
      name,
      fs.readFileSync(path.join(schemaDir, name), "utf8")
    );
  }
  return files;
}

/**
 * @param {string} name  Schema file name (for error messages).
 * @param {string} text  Raw file contents.
 * @returns {SchemaNode[]} Parsed schema file (namespace objects).
 */
function parse(name, text) {
  // Strip a UTF-8 BOM if present, then parse with JSON5 for tolerance.
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  try {
    return JSON5.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse schema file ${name}: ${err.message}`);
  }
}
