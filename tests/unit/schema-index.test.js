// Unit tests for the SchemaIndex resolver against the offline schema fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemaFiles } from "../../src/schema/load.js";
import { buildSchemaIndex, SchemaIndex } from "../../src/schema/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = buildSchemaIndex(
  loadSchemaFiles(path.join(here, "..", "schema-fixture"))
);

// The fixture's application/manifest version strings are exposed and the major
// components are parsed to numbers (128 and 3) for comparison.
test("reads applicationVersion and manifest version", () => {
  assert.equal(schema.applicationVersion, "128.0");
  assert.equal(schema.applicationVersionMajor, 128);
  assert.equal(schema.manifestVersionMajor, 3);
});

// Permissions defined in manifest.json combine with those added via $extend in
// other files, and unknown names like "bogusPermission" stay out of the union.
test("permission union merges $extend additions across files", () => {
  // Base enums from manifest.json plus the messages.json $extend additions.
  for (const p of [
    "storage",
    "alarms",
    "clipboardWrite",
    "notifications",
    "messagesRead",
    "accountsRead",
    "messagesMove",
    "messagesTagsList",
  ]) {
    assert.ok(schema.validPermissions.has(p), `expected permission ${p}`);
  }
  assert.ok(!schema.validPermissions.has("bogusPermission"));
});

// Top-level manifest keys merge the $extend addition compose_action with base
// keys, while an undeclared key is rejected from the valid-keys set.
test("manifest keys include $extend additions (compose_action)", () => {
  assert.ok(schema.validManifestKeys.has("compose_action"));
  assert.ok(schema.validManifestKeys.has("manifest_version"));
  assert.ok(schema.validManifestKeys.has("permissions"));
  assert.ok(!schema.validManifestKeys.has("weirdTopLevelKey"));
});

// A simple namespace.member path resolves to a function result carrying the
// split namespace and member names.
test("resolves a known function", () => {
  const res = schema.resolveApi(["messages", "list"]);
  assert.equal(res.kind, "function");
  assert.equal(res.namespace, "messages");
  assert.equal(res.member, "list");
});

// A three-segment path is split so the multi-part namespace messages.tags is
// recognized and list is treated as its member, not a nested property.
test("resolves a dotted sub-namespace (messages.tags.list)", () => {
  const res = schema.resolveApi(["messages", "tags", "list"]);
  assert.equal(res.kind, "function");
  assert.equal(res.namespace, "messages.tags");
  assert.equal(res.member, "list");
});

// Resolution distinguishes a missing namespace from a known namespace with an
// absent member, returning distinct unknown-namespace and unknown-member kinds.
test("flags unknown namespace and unknown member", () => {
  assert.equal(
    schema.resolveApi(["contextMenus", "create"]).kind,
    "unknown-namespace"
  );
  assert.equal(
    schema.resolveApi(["messages", "frobnicate"]).kind,
    "unknown-member"
  );
});

// A function's required permissions combine its own with the namespace-level
// ones, yielding the deduplicated, sorted union for messages.move.
test("required permissions merge namespace + function level", () => {
  const res = schema.resolveApi(["messages", "move"]);
  const perms = schema.requiredPermissions(res).sort();
  assert.deepEqual(perms, ["accountsRead", "messagesMove", "messagesRead"]);
});

// Accessing a property (storage.local) resolves to a property kind and still
// inherits the namespace permission, so reads are not treated as unguarded.
test("namespace-level permission applies to property access (storage.local)", () => {
  const res = schema.resolveApi(["storage", "local"]);
  assert.equal(res.kind, "property");
  assert.equal(res.namespace, "storage");
  // The "storage" permission gates the whole namespace, including property access.
  assert.deepEqual(schema.requiredPermissions(res), ["storage"]);
});

// Resolution follows a property's type to find a method on it, reporting the
// member as local.get under the storage namespace whose permission still gates it.
test("descends into a property type: storage.local.get resolves to a function", () => {
  const res = schema.resolveApi(["storage", "local", "get"]);
  assert.equal(res.kind, "function");
  assert.equal(res.namespace, "storage");
  assert.equal(res.member, "local.get");
  // Namespace permission still applies to the deep member.
  assert.deepEqual(schema.requiredPermissions(res), ["storage"]);
});

// Descending into a property type but hitting a nonexistent method reports
// unknown-member with the deepened namespace storage.local, not a silent pass.
test("flags an unknown method on a property type: storage.local.thisIsBad", () => {
  const res = schema.resolveApi(["storage", "local", "thisIsBad"]);
  assert.equal(res.kind, "unknown-member");
  assert.equal(res.namespace, "storage.local");
  assert.equal(res.member, "thisIsBad");
});

// Static helpers pull metadata off a resolved def: the deprecation message text
// and the version_added string ("200") for a not-yet-available API.
test("annotation helpers read version_added and deprecation", () => {
  const oldOne = schema.resolveApi(["messages", "oldOne"]).def;
  assert.equal(SchemaIndex.deprecation(oldOne), "Use list() instead.");
  const future = schema.resolveApi(["messages", "future"]).def;
  assert.equal(SchemaIndex.versionAdded(future), "200");
});

// fileLoaderMethods: a function with an extension-relative-path parameter (a
// rel-url format string, directly or reached through $ref / array items /
// object properties) is a file-loader; a plain string or a generic "url" is not.
test("derives fileLoaderMethods from rel-url-format parameters", () => {
  const idx = new SchemaIndex({
    "x.json": [
      {
        namespace: "demo",
        types: [
          {
            id: "FileOrCode",
            choices: [{ properties: { file: { $ref: "demo.RelUrl" } } }],
          },
          { id: "RelUrl", type: "string", format: "strictRelativeUrl" },
        ],
        functions: [
          {
            name: "loadDirect",
            parameters: [{ name: "p", type: "string", format: "relativeUrl" }],
          },
          {
            name: "loadViaRef",
            parameters: [
              {
                name: "o",
                type: "object",
                properties: {
                  js: { type: "array", items: { $ref: "demo.FileOrCode" } },
                },
              },
            ],
          },
          {
            name: "openUrl",
            parameters: [{ name: "u", type: "string", format: "url" }],
          },
          { name: "noFiles", parameters: [{ name: "n", type: "string" }] },
        ],
      },
    ],
  });
  assert.ok(idx.fileLoaderMethods.has("demo.loadDirect"));
  assert.ok(idx.fileLoaderMethods.has("demo.loadViaRef")); // via $ref/items/props
  assert.ok(!idx.fileLoaderMethods.has("demo.openUrl")); // generic url, not a path
  assert.ok(!idx.fileLoaderMethods.has("demo.noFiles"));
});

// The offline fixture schema defines messageDisplayScripts.register with a
// rel-url file parameter, so it is derived as a loader (no hardcoding needed).
test("derives the fixture's messageDisplayScripts.register loader", () => {
  assert.ok(schema.fileLoaderMethods.has("messageDisplayScripts.register"));
});
