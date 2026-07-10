// Local schema patch merged into the loaded annotated-schema files at review
// setup. Each fragment under assets/schema-annotations/ mirrors a schema-files
// namespace object, so it merges onto the schema by hierarchy - the same shape the
// Thunderbird comm-central annotations use. It carries entries the published
// schema does not yet have, pending the upstream update, in two shapes:
//   - the `web_api` permission grounding on a permission enum value (navigator.*
//     calls the browser.* schema cannot gate) -> SchemaIndex.permissionWebApis;
//   - a `required_permissions` annotation on a manifest-key property naming the
//     permission(s) that key requires (extensionScripts.json: compose_scripts ->
//     compose, message_display_scripts -> messagesModify) ->
//     SchemaIndex.manifestKeyPermissions.
//
// The merge OVERWRITES enum-value annotations (an existing one is replaced) but
// APPENDS a fragment property's `annotations` onto the loaded property's (other
// property keys are assigned). This is the deliberate difference from merge.js
// (whose arrays append unique) - a local fragment wins over any same-named entry
// the published schema may later carry, until the fragment is removed.
//
// Belongs here: loadSchemaAnnotations (locate + read the bundled fragments) and
// applySchemaAnnotations (the in-place overwrite merge). Does NOT belong here: the
// append-merge that assembles the schema itself (src/schema/merge.js), reading the
// schema files (src/schema/load.js), the query surface (src/schema/index.js), or
// deciding when to apply it (src/pipeline.js).

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemaFiles } from "./load.js";

/** @typedef {import("./index.js").SchemaNode} SchemaNode */

const here = path.dirname(fileURLToPath(import.meta.url));
const ANNOTATIONS_DIR = path.resolve(here, "../../assets/schema-annotations");

/**
 * Load the bundled annotation fragments (assets/schema-annotations/*.json), parsed
 * like schema files (JSON5/BOM-tolerant).
 * @returns {Record<string, SchemaNode[]>}  file name -> namespace objects.
 */
export function loadSchemaAnnotations() {
  return loadSchemaFiles(ANNOTATIONS_DIR).files;
}

/**
 * Merge annotation fragments into loaded schema files, in place. Matches a
 * namespace by `namespace` and a type by `id` (or by `$extend` when the fragment
 * type carries no id), then merges the fragment's enum-value annotations and any
 * native property fields onto it. A namespace/type absent from `files` is skipped.
 * @param {Record<string, SchemaNode[]>} files  Loaded schema files (mutated).
 * @param {Record<string, SchemaNode[]>} annotations  Fragments to merge in.
 */
export function applySchemaAnnotations(files, annotations) {
  for (const [name, nsList] of Object.entries(annotations)) {
    const target = files[name];
    if (!target) {
      continue;
    }
    for (const srcNs of nsList) {
      const dstNs = target.find((n) => n.namespace === srcNs.namespace);
      if (dstNs) {
        applyTypes(dstNs, srcNs);
      }
    }
  }
}

/**
 * @param {SchemaNode} dstNs  Loaded namespace object (mutated).
 * @param {SchemaNode} srcNs  Fragment namespace object.
 */
function applyTypes(dstNs, srcNs) {
  for (const srcType of srcNs.types ?? []) {
    for (const dstType of matchTypes(dstNs.types ?? [], srcType)) {
      // Place each fragment enum-value annotation onto the loaded node that actually
      // carries that value in its `enum` - the type itself, or one of its choices
      // (permission enums live in an OptionalPermission choice). This is value-
      // directed rather than structure-matched, so the fragment need not mirror the
      // choices layout, and it is symmetric with the reader (_collectPermissionWebApis).
      for (const [value, meta] of fragmentEnums(srcType)) {
        const node = enumNode(dstType, value);
        if (node) {
          node.enums ??= {};
          node.enums[value] = meta; // overwrite per value; never duplicates
        }
      }
      // Merge a fragment property onto the matching loaded property: APPEND its
      // `annotations` (so a manifest key's required_permissions annotation joins
      // any existing version_added rather than replacing it), and assign any other
      // keys. This is how the overlay delivers metadata the published schema lacks
      // (e.g. compose_scripts -> a required_permissions:["compose"] annotation).
      // Only patches a property the loaded type already declares, on whichever
      // matched block declares it.
      for (const [propName, srcProp] of Object.entries(
        srcType.properties ?? {}
      )) {
        const dstProp = dstType.properties?.[propName];
        if (!dstProp || !srcProp || typeof srcProp !== "object") {
          continue;
        }
        for (const [k, v] of Object.entries(srcProp)) {
          if (k === "annotations" && Array.isArray(v)) {
            dstProp.annotations = [...(dstProp.annotations ?? []), ...v];
          } else {
            dstProp[k] = v;
          }
        }
      }
    }
  }
}

/**
 * The loaded types a fragment type patches: the single type matched by `id` when
 * the fragment carries one, else EVERY block matched by `$extend` (a manifest
 * $extend block has no id, and the schema may spread one $extend target across
 * several blocks - each carrying different properties). Empty when neither
 * identifies a loaded type, so an id-less fragment cannot silently match the first
 * id-less loaded type.
 * @param {SchemaNode[]} types  Loaded namespace types.
 * @param {SchemaNode} srcType  Fragment type.
 * @returns {SchemaNode[]}
 */
function matchTypes(types, srcType) {
  if (srcType.id != null) {
    const byId = types.find((t) => t.id === srcType.id);
    return byId ? [byId] : [];
  }
  if (srcType.$extend != null) {
    return types.filter((t) => t.$extend === srcType.$extend);
  }
  return [];
}

/**
 * Every (enum value -> metadata) entry a fragment type carries, whether on the
 * type's own `enums` or on one of its choices.
 * @param {SchemaNode} type  Fragment type object.
 * @returns {[string, SchemaNode][]}
 */
function fragmentEnums(type) {
  const entries = Object.entries(type.enums ?? {});
  for (const choice of type.choices ?? []) {
    entries.push(...Object.entries(choice.enums ?? {}));
  }
  return entries;
}

/**
 * The loaded node whose `enum` contains `value`: the type itself, or the first
 * choice that lists it. Null when no node declares the value.
 * @param {SchemaNode} type  Loaded type object.
 * @param {string} value  The enum value to place an annotation on.
 * @returns {?SchemaNode}
 */
function enumNode(type, value) {
  if (Array.isArray(type.enum) && type.enum.includes(value)) {
    return type;
  }
  for (const choice of type.choices ?? []) {
    if (Array.isArray(choice.enum) && choice.enum.includes(value)) {
      return choice;
    }
  }
  return null;
}
