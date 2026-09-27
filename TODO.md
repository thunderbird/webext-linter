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
- Check against a real Experiment add-on that declares many members (`phoenity_icons-3.19`,
  the SmartTemplates versions) - it must gain no finding for an API its schema does declare.

## Skip the OSV and policy audit of the shipped XPI in an SCA review

The built XPI gets the full vendor chain in Phase 2 (`vendor-xpi` -> `cdn-bundled` ->
`audit-bundled`), and parts of it have a reader in a source review: `verifyPackage`
DISCOVERS the vendored files `classifyReview` marks non-authored (see the second half
below), and a `not-popular` outcome reaches the XPI-only advice through
`bundled.untrusted`. The vulnerability and policy audit layered on top is the part no
reader asks for.

`verifyVendor` (`src/vendor/verify.js`) calls `auditNpm` for each pinned package.json
dependency whose bytes the XPI carries, and `auditIdentifiedLibraries` does the same for
each hash-identified bundle; both record onto `xpiAddon.vendor.vulnerabilities` and
`.blocked`. Every reader of those two arrays - `vendor-vulnerable`, `banned-library`,
`vendor-vuln-unknown` - is `input: source`, which in an SCA review routes to the readable
source, whose own store Phase 3 fills independently (`verifyVendorDeclarations` +
`verifyScaDependencies` + `audit-source`). So in an SCA review the XPI's advisories are
written and never reached, and the OSV requests behind them buy nothing.

- Gate the AUDIT on the review mode, not the verification: `verifyPackage` and the hash
  identification must keep running on the XPI in both modes, because the classification
  depends on them. Only the `auditNpm` call each one wraps is mode-dependent.
- Settle the one case where the XPI's audit is not a duplicate first: a dependency pinned
  in the XPI's package.json that the source's package.json does not declare. Today its
  advisories are recorded and dropped, so nothing is lost by skipping the request - but if
  such a divergence should be reported at all, it is `undeclared-build-source` territory,
  not a second vulnerability audit.
- Nothing covers this path: `tests/addons/sca-dependency-audit/xpi/` ships no package.json,
  so no fixture has the XPI carry a pinned dependency during a source review.

Also open, and the harder half: whether the XPI's OWN package.json and VENDOR file should
be read at all in a source review. `verifyPackage` fetches the pinned release's listing,
hash-matches the shipped bytes against it and adds each hit to `vendor.set`
(`src/vendor/verify.js`), which `isVendored` turns into `nonAuthored`
(`src/lib/bundled.js`). In an SCA review exactly two readers consume that: the
`unused-files` exemption, so a vendored library nothing reaches is not reported as the
developer's unused file, and the inline-script skip set in `hasUnreviewableCode`. Nothing
else does - `resolveXpiOnlyAdvice` exempts only true hash-DB `tag.library` matches, NOT
`nonAuthored`, deliberately.

- The exemption has to stay INTRINSIC to the XPI whatever is decided: an `input: xpi` check
  reading the review target's `addon.vendor` is the error-severity false positive the
  artifact routing exists to prevent. So "take the non-authored set from the archive's
  VENDOR.md and toolchain instead" is not on the table; the choice is whether the XPI gets
  a vendored set at all in this mode.
- Both consequences of dropping it point toward MORE scrutiny, which is the safe direction:
  an unreached vendored library becomes an unused-files finding (it is dead weight either
  way), and a vendored page's inline script stops being skipped, which withholds the
  XPI-only advice.
- No fixture exercises the path: no `tests/addons/*/xpi/` carries a package.json or a
  VENDOR file, so nothing in the suite depends on the XPI having a vendored set. Offline a
  declaration does not verify anyway - it is reconciled into the untrusted family
  (`tests/expected/sca-vendor-declared.json` states this for the source side).

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

## Revisit the two `sca: false` checks, the last hand-declared mode gate

Once the review mode is derived from a check's `input` (an `input: sca` or `input: both`
check can only run in an SCA review, because those siblings exist nowhere else), the
`sca:` field survives for exactly two entries: `xpi-lock-file-invalid` and
`xpi-lock-file-missing`, both `input: source` + `sca: false`. No input can express what
they need - "the XPI, and only when it IS the review target" - because the built XPI is
analysed in both modes.

They are not the same question as their `sca: true` counterparts, which is why the pairs
were not simply merged: an XPI SHIPS a vendored copy, so its lock file pins that copy,
while an archive ships no copy and installs at build time, so its lock file pins what
will be installed. `scaEligible`'s docstring already states this.

What to look at:

- Whether "the review target, only when it is the XPI" deserves to be sayable as a route,
  rather than as a mode gate bolted beside the route.
- Whether the four lock checks are better as two checks that word one question per
  artifact, or whether the two questions really are distinct enough to stay four. The
  registry forbids an `sca: true` entry from wording its response per review mode
  (`registry.js:1266`), which is the constraint that produced four in the first place.
- Whichever way it lands, the goal is that a check declares WHERE it reads from and
  nothing else, and that a wrong declaration fails loudly rather than finding nothing.
