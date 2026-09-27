// The SHAPE of assets/registry.yaml's entry sections, declared once: which keys each
// section accepts, what each one holds, which are required, and which are recognized only
// to be refused. Everything else is unknown, and an unknown key is the failure this file
// exists for - nothing read it, so it was silently ignored, and the entry meant something
// other than what it said for as long as nobody looked.
//
// Each field carries its own `why`, which is the second half of every message raised from
// it. A refusal here says what the key would have COST, the way the hand-written assertions
// it replaced did - "a check's impact is configuration" rather than "expected a string" -
// because the person reading it is authoring a review rule, not debugging a type.
//
// Belongs here: the per-section key vocabulary, the value kinds, and the reason each rule
// exists. Does NOT belong here: anything that reads what the prose SAYS (a response's
// placeholders, a sweep instruction against its severity, a default-note against its
// response), anything needing more than one entry (settle-verbs against their phase), and
// anything about the top-level document (-> the assert* functions in registry.js, which run
// after this one and keep their own messages).

import {
  VALID_CHECK_SEVERITIES,
  VALID_CHECK_INPUTS,
  COLLAPSE_MODES,
  ANSWER_KINDS,
} from "./registry-vocabulary.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { SEVERITY, VERDICT_KEYS } from "../report/finding.js";

/**
 * The closed sets a `values:` or a `required:` in the yaml may name. Named rather than
 * inlined so the schema says WHICH vocabulary a key draws on, and so the two cannot drift:
 * a name that resolves to nothing throws here, on the first run, before the tool starts.
 */
const VOCABULARIES = {
  VALID_CHECK_SEVERITIES,
  VALID_CHECK_INPUTS,
  COLLAPSE_MODES,
  ANSWER_KINDS: new Set(ANSWER_KINDS),
  SEVERITY_BANDS: Object.values(SEVERITY),
  VERDICT_KEYS,
};

/** Resolve a `values:`/`required:` that names a vocabulary, or pass a literal list through. */
function vocabulary(named, at) {
  if (Array.isArray(named)) {
    return named;
  }
  const set = VOCABULARIES[named];
  if (!set) {
    throw new Error(
      `${SCHEMA_FILE}: ${at} names the vocabulary \`${named}\`, which is not one this ` +
        `review has (${Object.keys(VOCABULARIES).sort().join(", ")})`
    );
  }
  return set;
}

/** The yaml's kind names, as the walker below spells them. */
const KIND = {
  text: "text",
  "one-of": "oneOf",
  gate: "gate",
  list: "list",
  version: "version",
  refused: "refused",
  entries: "entries",
  object: "object",
  "prose-map": "proseMap",
  "map-of": "mapOf",
};

/** One authored field or nested section, with its yaml spelling normalized. */
function field(spec, shapes, at) {
  const kind = KIND[spec.kind];
  if (!kind) {
    throw new Error(
      `${SCHEMA_FILE}: ${at} has kind \`${spec.kind}\`, which is not one this schema ` +
        `knows (${Object.keys(KIND).join(", ")})`
    );
  }
  const out = {
    kind,
    why: spec.why,
    required: spec.required === true,
    mustExist: spec["must-exist"],
    allowEmpty: spec["allow-empty"] === true,
    of: spec.of,
    noun: spec.noun,
    nameKey: spec["name-key"] ?? "title",
    closed: spec.closed === true,
  };
  if (kind === "oneOf") {
    const named = vocabulary(spec.values, at);
    out.values = named instanceof Set ? named : new Set(named);
  }
  if (kind === "proseMap") {
    out.required = vocabulary(spec.required ?? [], at);
  }
  if (kind === "entries" || kind === "mapOf") {
    out.shape = shapeNamed(spec.shape, shapes, at);
  }
  if (kind === "object") {
    out.fields = Object.fromEntries(
      Object.entries(spec.fields).map(([key, f]) => [
        key,
        field(f, shapes, `${at} \`${key}\``),
      ])
    );
  }
  return out;
}

/** A named shape, with its `include` groups spread in ahead of its own fields. */
function shapeNamed(name, shapes, at) {
  const raw = shapes[name];
  if (!raw) {
    throw new Error(
      `${SCHEMA_FILE}: ${at} names the shape \`${name}\`, which is not declared ` +
        `(${Object.keys(shapes).join(", ")})`
    );
  }
  return raw;
}

/** Beside the file it describes, and read the same way (registry.js DEFAULT_REGISTRY). */
const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../assets/registry-schema.yaml"
);
const SCHEMA_FILE = "assets/registry-schema.yaml";

/** Read the schema beside the registry and resolve it once, at import. */
function loadSchema() {
  const doc = YAML.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  const groups = doc.groups ?? {};
  const shapes = Object.fromEntries(
    Object.entries(doc.shapes).map(([name, raw]) => {
      const { include = [], ...own } = raw;
      const merged = Object.assign(
        {},
        ...include.map((g) => {
          if (!groups[g]) {
            throw new Error(
              `${SCHEMA_FILE}: the shape \`${name}\` includes the group \`${g}\`, ` +
                `which is not declared (${Object.keys(groups).join(", ")})`
            );
          }
          return groups[g];
        }),
        own
      );
      return [name, merged];
    })
  );
  const resolvedShapes = Object.fromEntries(
    Object.entries(shapes).map(([name, fields]) => [
      name,
      Object.fromEntries(
        Object.entries(fields).map(([key, f]) => [
          key,
          field(f, shapes, `the shape \`${name}\` field \`${key}\``),
        ])
      ),
    ])
  );
  // A nested `shape:` resolves to the RESOLVED table, not the raw one.
  const relink = (f) => {
    if (f.shape && typeof f.shape === "object") {
      const name = Object.keys(shapes).find((n) => shapes[n] === f.shape);
      f.shape = resolvedShapes[name];
    }
    if (f.fields) {
      Object.values(f.fields).forEach(relink);
    }
  };
  Object.values(resolvedShapes).forEach((t) =>
    Object.values(t).forEach(relink)
  );
  const sections = Object.fromEntries(
    Object.entries(doc.sections).map(([name, spec]) => {
      const f = field(spec, shapes, `the section \`${name}\``);
      relink(f);
      return [name, f];
    })
  );
  return Object.freeze(sections);
}

/** Which shape each of the registry's sections takes - the whole vocabulary. A section not
 *  named here is not one the review reads, and neither is a key not named in its shape. */
export const SECTIONS = loadSchema();

/** Edit distance, capped: enough to tell a typo from a different word. */
function within(a, b, max) {
  if (Math.abs(a.length - b.length) > max) {
    return false;
  }
  let prev = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[b.length] <= max;
}

/**
 * The key this one was probably meant to be, or null. A separator or case slip counts as
 * exact, because `skip_in_sca_review` and `instructions-for-LLM` are the shapes a typo
 * actually takes in a yaml file.
 * @param {string} key @param {string[]} known @returns {?string}
 */
function nearest(key, known) {
  const fold = (k) => k.toLowerCase().replace(/[-_\s]/g, "");
  const folded = fold(key);
  return (
    known.find((k) => fold(k) === folded) ??
    known.find((k) => within(folded, fold(k), 2)) ??
    null
  );
}

/** Whether a declared field is itself a section kind rather than a value kind. */
const isSection = (f) =>
  f.kind === "entries" ||
  f.kind === "object" ||
  f.kind === "proseMap" ||
  f.kind === "mapOf";

/**
 * Assert one mapping against a flat field table: no key the table does not declare, no
 * value of the wrong kind, nothing required left out, nothing recognized-and-refused.
 * @param {object} entry  One mapping, as authored.
 * @param {object} shape  Its field table.
 * @param {string} where  How it is named in a message.
 */
export function assertFields(entry, shape, where) {
  const known = Object.keys(shape);
  for (const [key, value] of Object.entries(entry)) {
    // The marker allEntries() stamps on a manual check to tell the two kinds apart. It is
    // not something the yaml can author, so it is not part of any section's vocabulary.
    if (key === "manualCheck") {
      continue;
    }
    const field = shape[key];
    if (!field) {
      throw unknownKey(key, known, where);
    }
    if (field.kind === "refused") {
      throw new Error(`${where} authors \`${key}\`, ${field.why}`);
    }
    if (isSection(field)) {
      assertSection(value, field, `${where} \`${key}\``, key);
      continue;
    }
    const bad = (problem) =>
      new Error(
        `${where} has ${problem} \`${key}\` ${JSON.stringify(value)} - ${field.why}`
      );
    if (field.kind === "text") {
      const empty = field.allowEmpty ? false : value.trim?.() === "";
      if (typeof value !== "string" || empty) {
        throw bad("a missing or empty");
      }
    } else if (field.kind === "oneOf") {
      if (!field.values.has(value)) {
        throw new Error(
          `${where} has an invalid \`${key}\` ${JSON.stringify(value)} (expected one ` +
            `of: ${[...field.values].join(", ")}) - ${field.why}`
        );
      }
    } else if (field.kind === "gate") {
      if (value !== true) {
        throw new Error(
          value === false
            ? `${where} declares \`${key}: false\`, which is what leaving it out already ` +
                `means. Remove it - ${field.why}`
            : `${where} has a non-boolean \`${key}\` ${JSON.stringify(value)} - it is a ` +
                `gate, and anything else silently reads as false. ${field.why}`
        );
      }
    } else if (field.kind === "list") {
      const items = field.of === "mapping" ? "mapping" : "string";
      const wrong = (v) =>
        items === "mapping"
          ? !v || typeof v !== "object" || Array.isArray(v)
          : typeof v !== "string" || v.trim() === "";
      if (!Array.isArray(value)) {
        throw bad("a non-list");
      }
      if (value.length === 0 && !field.allowEmpty) {
        throw new Error(
          `${where} authors no ${field.noun ?? `\`${key}\``} - ${field.why}`
        );
      }
      if (value.some(wrong)) {
        throw bad(
          items === "mapping" ? "a non-mapping-valued" : "an empty-valued"
        );
      }
    } else if (field.kind === "version") {
      if (
        (typeof value !== "string" && typeof value !== "number") ||
        String(value).trim() === ""
      ) {
        throw bad("an unreadable");
      }
    }
  }
  for (const key of known) {
    const needed = shape[key].mustExist ?? shape[key].required;
    if (needed === true && entry[key] === undefined) {
      throw new Error(`${where} authors no \`${key}\` - ${shape[key].why}`);
    }
  }
}

/** The one message for a key nothing declares, wherever it was authored. */
function unknownKey(key, known, where) {
  const near = nearest(key, known);
  return new Error(
    `${where} authors \`${key}\`, which nothing reads${
      near ? ` - did you mean \`${near}\`?` : ""
    }. An undeclared key is not an error anything else notices: it is dropped, and ` +
      "the entry reads as though it never asked. This section accepts: " +
      `${known.slice().sort().join(", ")}`
  );
}

/**
 * Assert one SECTION against its declared kind, recursing where a field holds another
 * kind. Raised BEFORE the semantic assertions, so a rule that reads a field never reads
 * one of the wrong type - and so a typo is reported as a typo rather than as the absence
 * it would otherwise imitate.
 * @param {unknown} value  The section, as authored.
 * @param {object} kind  Its declared kind, from SECTIONS.
 * @param {string} where  How it is named in a message.
 * @param {string} [key]  Its key, for the "authors no ..." message.
 */
export function assertSection(value, kind, where, key) {
  const noun = kind.noun ?? (key ? `\`${key}\`` : "entries");
  if (kind.kind === "entries") {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`${where} authors no ${noun}`);
    }
    value.forEach((item, i) => {
      const at = `${where} entry ${i + 1}`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`${at} is not a mapping`);
      }
      assertFields(
        item,
        kind.shape,
        `${at} ("${item[kind.nameKey] ?? "untitled"}")`
      );
    });
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} authors no ${noun}`);
  }
  if (kind.kind === "object") {
    assertFields(value, kind.fields, where);
    return;
  }
  if (kind.kind === "mapOf") {
    for (const [name, item] of Object.entries(value)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`${where} \`${name}\` is not a mapping - ${kind.why}`);
      }
      assertFields(item, kind.shape, `${where} \`${name}\``);
    }
    return;
  }
  // proseMap: every required key present, every value prose, and - when closed - no key
  // a report cannot reach.
  for (const name of kind.required) {
    if (typeof value[name] !== "string" || value[name].trim() === "") {
      throw new Error(
        `${where} authors no \`${name}\` - the report reaches that case and would print ` +
          `nothing for it. ${kind.why}`
      );
    }
  }
  if (Object.keys(value).length === 0) {
    throw new Error(`${where} authors no ${noun} - ${kind.why}`);
  }
  for (const [name, text] of Object.entries(value)) {
    if (kind.closed && !kind.required.includes(name)) {
      throw new Error(
        `${where} authors \`${name}\`, which no report can reach (expected one of: ` +
          `${kind.required.join(", ")})`
      );
    }
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error(
        `${where} \`${name}\` is not prose ${JSON.stringify(text)} - ${kind.why}`
      );
    }
  }
}
