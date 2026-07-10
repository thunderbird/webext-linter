// Unit tests for the SchemaIndex resolver against the offline schema fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemaFiles } from "../../src/schema/load.js";
import { buildSchemaIndex, SchemaIndex } from "../../src/schema/index.js";
import {
  loadSchemaAnnotations,
  applySchemaAnnotations,
} from "../../src/schema/annotate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "schema-fixture");
const schema = buildSchemaIndex(loadSchemaFiles(FIXTURE));

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

// The pristine fixture carries no `web_api` data - it comes only from the local
// schema annotations, merged in at setup. After merging, a permission enum value's
// `web_api` annotation is exposed keyed by permission name; permissions without the
// annotation (or not in this fixture's enum) are absent.
test("permissionWebApis exposes the merged web_api annotation", () => {
  assert.equal(schema.permissionWebApis.size, 0);

  const loaded = loadSchemaFiles(FIXTURE);
  applySchemaAnnotations(loaded.files, loadSchemaAnnotations());
  const annotated = buildSchemaIndex(loaded);

  assert.deepEqual(annotated.permissionWebApis.get("clipboardRead"), [
    { receiver: "navigator.clipboard", methods: ["read", "readText"] },
  ]);
  assert.deepEqual(annotated.permissionWebApis.get("clipboardWrite"), [
    { receiver: "navigator.clipboard", methods: ["write", "writeText"] },
  ]);
  assert.deepEqual(annotated.permissionWebApis.get("geolocation"), [
    {
      receiver: "navigator.geolocation",
      methods: ["getCurrentPosition", "watchPosition", "clearWatch"],
    },
  ]);
  assert.ok(!annotated.permissionWebApis.has("notifications"));
  assert.ok(!annotated.permissionWebApis.has("storage"));
});

// Top-level manifest keys merge the $extend addition compose_action with base
// keys, while an undeclared key is rejected from the valid-keys set.
test("manifest keys include $extend additions (compose_action)", () => {
  assert.ok(schema.validManifestKeys.has("compose_action"));
  assert.ok(schema.validManifestKeys.has("manifest_version"));
  assert.ok(schema.validManifestKeys.has("permissions"));
  assert.ok(!schema.validManifestKeys.has("weirdTopLevelKey"));
});

// A manifest key whose property carries a `required_permissions` annotation
// requires that permission (compose_scripts -> compose,
// message_display_scripts -> messagesModify). Keys without one - including the
// array-typed `permissions` property itself - never enter the map.
test("manifestKeyPermissions reads the required_permissions annotation", () => {
  assert.deepEqual(schema.manifestKeyPermissions.get("compose_scripts"), [
    "compose",
  ]);
  assert.deepEqual(
    schema.manifestKeyPermissions.get("message_display_scripts"),
    ["messagesModify"]
  );
  assert.ok(!schema.manifestKeyPermissions.has("permissions"));
  assert.ok(!schema.manifestKeyPermissions.has("content_scripts"));
});

// The bundled extensionScripts.json overlay is what delivers those permissions in
// production (the published schema lacks the field). Exercise the full
// load -> applySchemaAnnotations -> $extend-merge -> read chain with the REAL
// overlay: without it the keys carry no permissions; with it they are grounded.
test("the bundled extensionScripts overlay grounds manifest-key permissions end-to-end", () => {
  const files = () => ({
    "manifest.json": [
      {
        namespace: "manifest",
        types: [{ id: "WebExtensionManifest", type: "object", properties: {} }],
      },
    ],
    "extensionScripts.json": [
      {
        namespace: "manifest",
        types: [
          {
            $extend: "WebExtensionManifest",
            properties: {
              compose_scripts: { type: "array" },
              message_display_scripts: { type: "array" },
            },
          },
        ],
      },
    ],
  });
  // Baseline: the schema declares the keys but no permission annotation.
  assert.equal(new SchemaIndex(files()).manifestKeyPermissions.size, 0);
  // With the real bundled overlay applied, the required_permissions annotation lands.
  const patched = files();
  applySchemaAnnotations(patched, loadSchemaAnnotations());
  const idx = new SchemaIndex(patched);
  assert.deepEqual(idx.manifestKeyPermissions.get("compose_scripts"), [
    "compose",
  ]);
  assert.deepEqual(idx.manifestKeyPermissions.get("message_display_scripts"), [
    "messagesModify",
  ]);
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

// A registered experiment base namespace is accepted wholesale: the bare
// namespace and any sub-path under it resolve as a known experiment API (the
// developer owns it), while an unrelated namespace stays unknown. Uses a fresh
// index so the registration does not leak into the shared `schema`.
test("a registered experiment base namespace covers its sub-paths", () => {
  const idx = buildSchemaIndex(
    loadSchemaFiles(path.join(here, "..", "schema-fixture"))
  );
  assert.equal(idx.resolveApi(["calendar"]).kind, "unknown-namespace");
  idx.registerExperimentNamespaces(["calendar"]);
  assert.equal(idx.resolveApi(["calendar"]).kind, "experiment");
  assert.equal(idx.resolveApi(["calendar", "items"]).kind, "experiment");
  assert.equal(idx.resolveApi(["calendar", "items", "get"]).kind, "experiment");
  // An unrelated namespace is still unknown.
  assert.equal(idx.resolveApi(["weatherWidget"]).kind, "unknown-namespace");
});

// A function's required permissions combine its own with the namespace-level
// ones, yielding the deduplicated, sorted union for messages.move.
test("required permissions merge namespace + function level", () => {
  const res = schema.resolveApi(["messages", "move"]);
  const perms = schema.requiredPermissions(res).sort();
  assert.deepEqual(perms, ["accountsRead", "messagesMove", "messagesRead"]);
});

// A function whose ONLY extra permission is function-level (archive -> messagesMove,
// delete -> messagesDelete) still yields it, unioned with the namespace's
// messagesRead. This is the path the unused-permission-recheck alias fix depends on.
test("required permissions include a function-level-only permission", () => {
  const archive = schema.resolveApi(["messages", "archive"]);
  assert.equal(archive.kind, "function");
  assert.deepEqual(schema.requiredPermissions(archive).sort(), [
    "messagesMove",
    "messagesRead",
  ]);
  const del = schema.resolveApi(["messages", "delete"]);
  assert.deepEqual(schema.requiredPermissions(del).sort(), [
    "messagesDelete",
    "messagesRead",
  ]);
});

// A nested namespace is gated by its parent namespace's permission too: calling
// scripting.messageDisplay.registerScripts needs BOTH the parent "scripting"
// permission and the sub-namespace's "messagesRead". resolveApi longest-prefix
// matches scripting.messageDisplay, so requiredPermissions must walk up to the
// scripting ancestor rather than only reporting the deepest namespace's perm.
test("required permissions include ancestor sub-namespaces", () => {
  const idx = new SchemaIndex({
    "scripting.json": [
      { namespace: "scripting", permissions: ["scripting"], functions: [] },
      {
        namespace: "scripting.messageDisplay",
        permissions: ["messagesRead"],
        functions: [{ name: "registerScripts", async: true }],
      },
    ],
  });
  const res = idx.resolveApi([
    "scripting",
    "messageDisplay",
    "registerScripts",
  ]);
  assert.equal(res.kind, "function");
  assert.equal(res.namespace, "scripting.messageDisplay");
  assert.deepEqual(idx.requiredPermissions(res).sort(), [
    "messagesRead",
    "scripting",
  ]);
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
