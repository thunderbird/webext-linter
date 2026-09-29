# TODO

Open work.

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

## Check whether the excluded Experiment subtree escapes the vendor checks

With `--sca-exp-source`, `scaViews` splits that subtree out of `files` into its own view, and
only two callers put the two back together: `collectJsSources` (`src/addon/sources.js:91`), so
the Experiment's JS **is** parsed and reaches every `jsSources` check, and `classifyFiles`
(`src/lib/bundled.js:133`), so it is classified for library/minified/obfuscation. Everything
else that walks `ctx.artifact.files` on the SOURCE route never sees it.

Two checks are on that route and read the files directly:

- `unpinned-vendor-source`
- `vendor-vuln-unknown`

So a vendored library sitting inside the privileged subtree would escape the vendor checks.
(The other direct readers - `bundled-files`, `unused-files`, `background-page-module`,
`minimize-web-accessible-resources`, `missing-english-localization`,
`unrecognized-manifest-key` - are `input: xpi`, and the built XPI ships its Experiment
implementation like any other file, so they see it either way.)

A second half, verified separately: a build step naming a file under `--sca-exp-source`
(`"build": "sh exp/evil.sh"`) resolves to nothing in `collectBuildFiles` and raises no
`unresolved` signal, so the build trace cannot see it either.

- The test is a submission reviewed twice, with and without the flag, diffing the reports:
  passing `--sca-exp-source` must not REDUCE coverage.
- No fixture covers a vendored library inside the Experiment subtree; that is what would pin
  whichever way this is settled.

## Who has authority over the code in an SCA review?

Example the experiment code. Which one is reviewed? Do we at all look at code in the XPI? 

Is the entire security model based on the assumption that "we reviewed SCA and trust that the build process creates a XPI based on the reviewed code? The build process could do all kinds of stuff.

This is why we take the manifest ONLY from the XPI. 

I have the feeling that teh same should be valid for the experiment code, we should take the experiment code from the XPI as authorative.

How do we currently review the XPI of an SCA?
- we do not allow obfuscated code
-  we *can* review minified code, right? so we basically do a full review of the XPI?
- the problem is probably eval() or innerHtml usage from a lib (allowed) not being excluded from the review, as it cannot be detected?

## Report an unused or over-vendored library, and keep the unused-files exemption

`unused-files` skips every non-authored file (`nonAuthoredJs`: VENDOR declarations,
hash-matched libraries, minified, obfuscated). A new pair of checks should own exactly
those files, but at LIBRARY granularity rather than per file.

The exemption stays. Deleting it was implemented and swept over the review corpus, and it
false-positives: a library loads its own parts by paths no static read produces (webpack
chunks by computed id, TinyMCE plugins by an injected `script.src`). Partial use of a
vendored distribution is normal and statically undecidable, which is the reason the
exemption is right - and the skip itself could say so, which it does not today. While
there: `new Set(nonAuthoredJs(ctx))` copies a Set that `nonAuthoredJs` already returns.

The shape worth reporting is not a dead file but an over-vendored package. Measured:
thunderpen ships 197 TinyMCE files, its `signature/editor.js` configures 12 of the 28
plugins it ships, and it uses one skin out of 44 skin files. The library is genuinely
used, most of what ships is not, and nothing static can tell which parts the config
activates.

The library is identifiable, so the unit exists: with `--cdn-lib-lookup` (default true)
each file hash-matches jsDelivr as `tinymce`, carrying the upstream path on `cdn.url`. The
Mozilla hash DB has no TinyMCE entries at all, so the CDN route is what identifies it.
Group by `libraryId.name` ONLY - that one tree resolves to 8.4.0, 8.5.0 and 8.6.0, because
unchanged files share hashes across releases.

Two checks, reading one shared computation, since a registry entry carries one response:
one for a library where nothing at all is loaded (definite - remove it), one for a library
where the bulk has no traceable load (info - vendor only the parts you use). The second
must never word its count as "unused": those 12 plugins and that skin really are loaded.
It reports per library, never per file, which is what keeps it free of wrong line items.

Trap for the implementation: a VENDOR-declared file gets no `BundleTag` at all -
`classifyFiles` adds it to `nonAuthored` and continues before hashing - so a tag-only
design would cover undeclared libraries and skip declared ones, which is backwards.
Declarations have to come in as their own unit source, via `declaredFiles`.
