# Local schema annotations

Annotation fragments merged into the annotated schema files at review setup
(`applySchemaAnnotations` in [`src/schema/annotate.js`](../../src/schema/annotate.js),
called from `src/pipeline.js`). Each file mirrors the structure of a
`schema-files/<namespace>.json` file so it can be merged onto the loaded schema by
hierarchy — the same shape the Thunderbird
[comm-central annotations](https://searchfox.org/comm-central/source/mail/components/extensions/annotations)
use.

The merge overwrites **per enum value**: an annotation for an entry that already
exists in the schema replaces it rather than duplicating. This lets a fragment here
act as a local override until the same annotation ships in the published schema, at
which point the fragment can be removed.

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
