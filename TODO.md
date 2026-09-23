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

## Say when a library could not be verified, instead of calling it unpopular

`npmDownloads` (`src/vendor/verify.js`) returns `null` rather than `0` on purpose, so
that "nobody answered" stays distinguishable from "a low number". `isPopular` then throws
that away: `downloads !== null && downloads >= VENDOR_NPM_MIN_DOWNLOADS` collapses `null`
to `false`, which means *not widely used*. That verdict withdraws the file's exemption
(`markUntrusted`), so it is reviewed as the developer's own code, and a minified one is
rejected by `untrusted-minified-library`.

So an unanswered lookup and a genuinely obscure package are the same value by the time the
bar sees them - the same sentence the popularity gate's own commit used about 429s. The
gate (the per-host interval and the retry, now in `src/util/net.js`) only makes the
collapse RARE. One request that goes unanswered - a hang, which is deliberately not
retried - still silently demotes a real library, and nothing in the report says a lookup
failed.

Fix the collapse rather than the frequency: carry the unanswered reading through to the
report, so the reviewer is told the library could not be verified as widely used, instead
of being told it is not. The safe direction stays what it is today (an unverifiable file
is reviewed as authored code, never exempted on an unanswered lookup) - what changes is
that the report says so.

The same swallow exists at `auditNpm`, where an unreachable OSV records no advisories and
reads as a clean bill of health.

## Decide whether a local path inside the submission is an unsupported source

`unsupported-dependency` rejects any dependency spec that is neither an exact npm version
nor a GitHub URL, in both review modes. `classifyDeps` (`src/vendor/resolve.js`)
routes anything containing `:` or `/` that `parseGithubSpec` does not recognise into the
`unsupported` bucket, which is a hard error.

That catches `file:`, `link:` and `workspace:` specs, which point INSIDE the submission.
The code they name is present and reviewable, not fetched from a source we cannot verify -
the opposite of what the check is for. In an SCA review they are ordinary build specs: the
lock records them and the reviewer installs from it.

Measured: markdown-here-revival (4.0.14 and 4.0.16) declares
`"@jfx2006/mailext-options-sync": "file:./mailext-options-sync"` in production
`dependencies` and is rejected for it. It is the only add-on in the review corpus that
uses the form, so this is a real rejection rather than a hypothetical one.

The same file declares `"eslint-plugin-mailextensions-env":
"file:tools/eslint-plugin-mailextensions-env"` in `devDependencies`, which used to vanish.
It no longer does: a build dependency's SOURCE is now held to the same bar wherever the
reviewer installs from the artifact, so both are rejected alike and the question below is
one question rather than two.

To settle:

- whether a path inside the submission is a supported source at all, and if so whether it
  must additionally resolve to a directory the archive contains;
- whether the answer differs by review mode - the XPI case is a vendoring declaration
  whose bytes must match a published release, the SCA case is a build input the reviewer
  installs.

The response no longer offers the lock file as a source (that clause belonged to the
pinnability axis and is gone), but it still has to say what it accepts once the question
above is settled.

## Stop reading the XPI for anything but the downgrade check in an SCA review

In a source-code review, third-party code is either installed by the toolchain
(package.json + lock) or declared in a `VENDOR.md`. The shipped XPI is looked at for one
thing only: deciding whether an XPI-only submission would have done (`sca-not-required`,
via `hasUnreviewableCode` over `xpiAddon.bundled`). Two things break that.

`unused-files` is `input: xpi` with no `sca:` flag, so in an SCA review it runs against the
shipped artifact and takes its non-authored set from `xpiAddon.bundled` - which
`verifyPackage` fills from the XPI's own package.json by hash-matching shipped bytes
against the pinned release. That is a second reader of the XPI's vendoring manifest. In an
SCA review the non-authored set should come from the archive's `VENDOR.md` and toolchain
instead.

`verifyVendor(xpiAddon)` also calls `auditNpm`, filling `xpiAddon.vendor.vulnerabilities`
and `.blocked`, but `vendor-vulnerable` and `banned-library` are `input: source` and read
the archive's store. In an SCA review those requests are spent on a result nothing reads.
