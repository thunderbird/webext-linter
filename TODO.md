# TODO

Open work. Background, rationale and anything already decided are in `SETTLED.md`.

## Tag path parameters in the schema, then delete the bridge entries

For each method below, tag its path parameter in the schema with a `REL_URL_FORMATS`
format, then delete that method's entry from the `bridge` map in
`assets/webext-facts.yaml`:

- `runtime.getURL` (arg0), both versions
- `tabs.executeScript` / `.insertCSS` / `.removeCSS` ({file}/{files}), MV2 only
- `scripting.executeScript` / `.insertCSS` / `.removeCSS` ({file}/{files}), both
- `tabs.create` ({url}), both
- `browserAction.setPopup` (MV2) / `action.setPopup` (MV3) ({popup})
- `composeAction` / `messageDisplayAction` `.setPopup` ({popup}), both

If a new extension-relative format name appears upstream, add it to `REL_URL_FORMATS`
(`src/schema/index.js`).

## Promote the prose permission gates to schema data

In the schema generator, give every property whose `description` carries
`<permission>X</permission>` a machine-readable `permissions` field - 31 properties. No
linter change: the existing resolver plus the `assets/schema-annotations` overlay grounds
them once the field is there.

## Scan every non-vendored file for eval

`getEvalScan` (`src/lib/eval-scan.js`) skips two sets: `nonAuthoredJs` and
`pureWebExtensionReachable`. Drop the second one. Every file the add-on authored is scanned,
vendored and library files are not, and nothing else gates it.

- Remove the `webext.has(src.file)` condition from the scan loop, and with it the
  `buildReachability` call if nothing else in the module needs it.
- Rewrite the module header: it currently explains the WebExtension skip as deliberate, and
  that reasoning is gone. State what it does now - authored files in, vendored files out.
- `eval-call`, `function-constructor`, `string-timer` and `remote-eval` all read
  `getEvalScan(ctx).hits`, so all four widen together. No check changes.
- Expect new findings: 12 corpus add-ons have an eval construct in non-privileged
  non-vendored JS, most of them bundled libraries sitting at paths `nonAuthoredJs` does not
  recognise (`background/jszip.min.js`, `notes/pouchdb-7.2.1.js`). Check those against the
  vendored classification rather than re-narrowing the scan.
- Regenerate the goldens this moves, and keep `tests/addons/eval-non-webext` reporting.

## Register an Experiment schema's members, not only its namespace

`registerExperimentNamespaces` (`src/schema/index.js`) adds only the namespace NAME, and
`resolveApi` then treats everything under it as known by longest-prefix match. So
`browser.myTools.getBarrr()` passes even when the add-on's own schema declares only `getFoo`,
and at runtime it is undefined.

- Register the parsed schema's types alongside its name, as a second mutator beside
  `registerExperimentNamespaces`. The index is built before the Experiment is classified, so
  this is not a `buildSchemaIndex` change. An Experiment schema is the same annotated format
  the published schemas use, so it needs no second code path.
- Keep today's opaque prefix wherever `experimentApiNamespaces` (`src/lib/experiments.js`)
  falls back to the manifest because the schema is missing, unreadable or unparseable - a
  malformed developer file must not turn into a wave of unknown-member reports.
- Leave `experiment-unknown-api` and the built-in namespace collision alone: both settled
  (`SETTLED.md`).
- Check against a real Experiment add-on that declares many members (`phoenity_icons-3.19`,
  the SmartTemplates versions) - it must gain no finding for an API its schema does declare.
