// A known manifest key whose value has the wrong type - validated with ajv
// against a JSON Schema derived from the annotated manifest schema. Thunderbird
// misreads such values, so it is a warning. Conservative: it never throws, and a
// compile failure disables it, so a translation gap cannot wrongly flag a valid
// manifest.
//
// Belongs here: low-noise value-type violations (the REPORTABLE ajv keywords).
// Does NOT belong here: unknown top-level keys (->
// unrecognized-manifest-key.js), deriving the JSON Schema (->
// src/schema/json-schema.js: buildManifestJsonSchema), authored wording (->
// assets/registry.yaml), and severity (-> that registry entry).

import { VERDICT } from "../../lib/enum.js";
import Ajv from "ajv";
import { finding } from "../../report/finding.js";
import { buildManifestJsonSchema } from "../../schema/json-schema.js";

// Keywords whose violations are concrete and low-noise. anyOf/oneOf/required/
// additionalProperties errors are deliberately ignored (cascade noise / not
// enforced by the conservative schema).
const REPORTABLE = new Set([
  "type",
  "enum",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
]);

export default {
  run(ctx) {
    const { schema } = ctx;
    if (ctx.manifestError || !ctx.manifest) {
      return { findings: [] };
    }
    let validate;
    try {
      const jsonSchema = buildManifestJsonSchema(schema);
      if (!jsonSchema) {
        return { findings: [] };
      }
      validate = new Ajv({ allErrors: true, strict: false }).compile(
        jsonSchema
      );
      if (validate(ctx.manifest)) {
        return { findings: [] };
      }
    } catch {
      return { findings: [] };
    }

    const out = [];
    const seen = new Set();
    for (const err of validate.errors || []) {
      if (!REPORTABLE.has(err.keyword)) {
        continue;
      }
      const where =
        (err.instancePath || "").replace(/^\//, "").replace(/\//g, ".") ||
        "(root)";
      const key = `${where}|${err.keyword}|${err.message}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      ctx.note?.(
        "manifest.json",
        null,
        `${where} (${err.keyword})`,
        VERDICT.FAIL
      );
      // The entry is the locus subject and the ajv diagnostic its detail, so every
      // mistyped value shares one message and they collapse into a single entry
      // listing "<entry> - <what is wrong>" per line.
      out.push(
        finding({
          file: "manifest.json",
          item: where,
          hint: err.message,
        })
      );
    }
    return { findings: out };
  },
};
