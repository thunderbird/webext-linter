# Local schema annotations

Annotation fragments merged into the annotated schema files at review setup
(`applySchemaAnnotations` in [`src/schema/annotate.js`](../../src/schema/annotate.js),
called from `src/pipeline.js`). Each file mirrors the structure of a
`schema-files/<namespace>.json` file so it can be merged onto the loaded schema by
hierarchy — the same shape the Thunderbird
[comm-central annotations](https://searchfox.org/comm-central/source/mail/components/extensions/annotations)
use.

The merge matches a namespace by `namespace`, a type by `id` **or** `$extend` (a
manifest `$extend` block has no id), and a member by `name`. It then:

- **overwrites per enum value** — an enum-value annotation replaces an existing one
  rather than duplicating; and
- **appends** a fragment property's or member's `annotations` onto the loaded
  node's, **deduping** identical entries (so it stays idempotent and joins any
  `version_added` the published schema already carries rather than clobbering it).

Either way a fragment here acts as a local override/addition until the same
annotation ships in the published schema, at which point the fragment can be
removed cleanly.

## `theme.json` — `ThemeManifest.icons` is a packaged path

`manifest.WebExtensionManifest.icons` types each size-keyed value as
`manifest.ExtensionFileUrl` (`format: strictRelativeUrl`), but
`manifest.ThemeManifest.icons` in `theme.json` types the same values as a bare
`string`. It is the same key with the same meaning, and a static theme's icon is a
packaged file exactly as an add-on's is.

The fragment retypes it to match. `bundled-files` walks the manifest against its schema
types and reports a declared path that is not in the package, so with the bare-string
typing a theme's missing icon was invisible to it, and any other consumer reading the
schema to learn which keys carry a file path would draw the same wrong conclusion.

Remove this fragment once `theme.json` upstream types the value as `ExtensionFileUrl`.

## `manifest.json` — `web_api` permission grounding

Supplies the `web_api` annotation on the `manifest.OptionalPermission` enum values
for the permissions the `browser.*` schema cannot gate because their capability
lives on a Web/DOM API (`navigator.*`): `clipboardRead`, `clipboardWrite`,
`geolocation`. Each lists the receiver + methods whose call proves the permission
used; the permission grounding reads it via `SchemaIndex.permissionWebApis` (see
`_collectPermissionWebApis` in `src/schema/index.js`) and the AST match in
`src/parse/web-api-calls.js`.

Data source: mined from [`@mdn/browser-compat-data`](https://github.com/mdn/browser-compat-data)
(clipboard) and MDN (geolocation, which carries no BCD note). Keep it in sync with
the eventual upstream annotation.

## `extensionScripts.json` — manifest-key permission grounding

Adds a `required_permissions` annotation
(`annotations[].additional_properties.required_permissions`) onto the
`compose_scripts` and `message_display_scripts` manifest-key properties (via a
`$extend: "WebExtensionManifest"` block): the permission(s) a declared key requires,
which the `browser.*` API gate never covers (`compose_scripts` → `compose`,
`message_display_scripts` → `messagesModify`). `SchemaIndex.manifestKeyPermissions`
(see `_collectManifestKeyPermissions`) reads it; the missing-/unused-permission
grounding (`analyzePermissions` in `src/lib/permissions.js`) grounds a
declared key's permission as used and flags an undeclared one as missing.

An entry may carry a `min_strict_version`/`max_strict_version` bound, so a
version-dependent requirement is several entries the grounding version-filters (see
the boundary-crossing check).

## `tabs.json` — version-bounded review notes

Adds `note` annotations onto API members (e.g. `tabs.query`), each with an optional
`min_strict_version`/`max_strict_version` bound. They record a version-dependent fact
about the member for the API docs. `SchemaIndex.memberNotes` reads them back; no check
consumes one today.
