# Table of Contents

- [Improve schema files to remove special hardcoded cases](#improve-schema-files-to-remove-special-hardcoded-cases)
- [Full type check via typescript engine](#full-type-check-via-typescript-engine)
- [Potential permission tracing via typescript engine](#potential-permission-tracing-via-typescript-engine)
- [Unused-files pre-flight backstop (anchored templates + content type)](#unused-files-pre-flight-backstop-anchored-templates--content-type)
- [Re-evaluate fully schema-driven manifest file-ref extraction](#re-evaluate-fully-schema-driven-manifest-file-ref-extraction)

# Improve schema files to remove special hardcoded cases

The `BRIDGE` map in `src/parse/loader-files.js`: file-loading APIs whose path
parameter the schema does not tag as an extension-relative URL, so we hardcode
where the path sits (used by bundled-files + reachability). The schema-directed
path (`SchemaIndex._collectFileLoaderMethods` in`src/schema/index.js`) derives a
loader only when a parameter's type tree reaches a `REL_URL_FORMATS` leaf. APIs
typed as a plain string / generic "url" carry no marker and need the bridge. The
bridge is manifest-version-aware (an `mv` tag restricts an entry to one version).
Tag these path parameters in the schema, then delete the matching bridge entry
(it becomes dead):

- `runtime.getURL` (arg0), both versions
- `tabs.executeScript`/`.insertCSS`/`.removeCSS` ({file}/{files}), MV2 only
- `scripting.executeScript`/`.insertCSS`/`.removeCSS` ({file}/{files}), both
- `tabs.create` ({url}), both
- `browserAction.setPopup` (MV2) / `action.setPopup` (MV3) ({popup})
- `composeAction`/`messageDisplayAction` `.setPopup` ({popup}), both

Also hardcoded: `REL_URL_FORMATS` in `src/schema/index.js` (relativeUrl,
strictRelativeUrl, imageDataOrStrictRelativeUrl, unresolvedRelativeUrl). These
are the schema format names treated as extension-relative. A new such format
name in the schema would need adding here too.

# Full type check via typescript engine

The schema review currentlyx only matches call *names*: it parses the JavaScript,
resolves each `browser.*` / `messenger.*` / `chrome.*` call against the API
surface, and checks that the API exists and that its permissions are declared.
It never checks how the developer *uses* the values an API returns or accepts:
argument shapes, return-value structure, property access. Those are real, common
bugs we currently miss.

The canonical example is `messages.query` / `messages.list`, which return a
`MessageList` (`{ id: string | null, messages: MessageHeader[] }`), not a plain
array. A developer who writes `result.length` or `for (const msg of result)` has
a bug: the messages live on `result.messages`, and paging to the next chunk
needs `messages.continueList(result.id)`. Name-matching cannot see this, but a
real type check can.

We plan to publish TypeScript definition files generated from the annotated
schemas, so the future plan is to run an actual static type check of the
submission against them: feed the WebExtension `.d.ts` as ambient types and type-
check the add-on's JS with the TypeScript engine (`tsc` or the language-service
API, with `allowJs` + `checkJs`). The key is to let everything untyped degrade
to `any` (i.e. no `noImplicitAny`), so we only surface diagnostics that touch
the *typed* WebExtension surface and do not drown in noise from the developer's
own untyped code. The TS diagnostics then map onto our finding model (file:line
and message).

# Potential permission tracing via typescript engine

This is the permission-specific payoff of the type check above. Currently, we
only have missing permission checks based on functions. We need an unused
permission check but need to be sure we saw all property gated permissions and
also all function/event gated permissions.

With the TypeScript engine in place we get the flow for free. The type checker
knows the static type of every expression, so for each property access
`obj.prop` (and each property set on an object literal passed to an API) we can
resolve the static type of `obj` to a schema type and look up whether
`<type>.<prop>` is gated. That lookup uses the same `<permission>` tags /
structured `permissions` data we already parse, only keyed by (type, property)
instead of walked over a function signature. A gated property that is actually
read or set means the permission is genuinely required, deterministically and at
an exact file:line.

That collapses both checks into precise, token-free ones:

- missing: a gated property is read but the permission is not declared, which is
  a warning with no over-approximation and no manual review.
- unused: a permission is declared but no gated property that would require it
  is read or set anywhere in the add-on.

Caveat: context-dependent gates stay advisory. `menus.OnClickData.attachments`,
for instance, needs `compose` in a compose tab and `messagesRead` in a display
tab. Which permission applies depends on runtime context the type system does
not capture, so a property bound to several permissions still resolves to a
permission *set*, not a single one. Single-permission gates (the vast majority)
become exact.

Concrete instance today: `cookies` is gated only by *setting* `cookieStoreId` on
`tabs.create` / `windows.create` / `spaces.create`/`update` (an object-literal property
set on an API argument, per above) - never by reading it. It is the one argument-gated
recheck permission (it has a `permission-prompts` entry in `assets/registry.yaml`),
currently routed to the LLM only because the name-only resolver cannot see the argument
value; once this tracing lands `cookies` becomes deterministic and its prompt can be
dropped (leaving only property-read / gesture cases). `PERMISSION-GROUNDING-GAPS.md`
inventories every property/argument gate on the recheck permissions this tracing covers.

A permission that gates neither an API nor a property - `unlimitedStorage`, which only
raises the storage quota - falls outside this tracing (there is no gate to look up). It is
justified by the add-on actually persisting data at runtime, which the type checker cannot
weigh, so it stays LLM-judged. Its former hand-coded `NO_API_GATE` exemption in
`src/lib/permissions.js` has been removed in favour of a `permission-prompts` entry
- the same LLM interim as the property-gated permissions.

# Unused-files pre-flight backstop (anchored templates + content type)

The deterministic loader pre-flight removes only the false dynamic loaders (an
inline getURL of a literal passed to a loader slot, a static-file-part template
such as getURL(`popup.html?id=${x}`), and the loaders inside vendored or library
files). A genuinely computed loader still falls back to the old blanket, where
every name-absent unreachable file becomes an LLM candidate against every
dynamic loader site. This backstop makes that precise, so the LLM is asked only
about the cases we truly cannot decide deterministically.

- Capture each dynamic loader site as a path template: the static prefix
  directory and suffix extension pulled from the template literal or string
  concatenation, plus the loader kind (js for import or importScripts or
  executeScript, css for insertCSS, url for getURL which is type agnostic).
- Match per file. A file is a candidate for an anchored site only when its path
  fits the prefix and suffix. If no site can load the file, it is a
  deterministic orphan with no LLM call.
- For an opaque loader with no static anchor, decide by content. A js or css
  loader cannot load a file whose content is a confirmed binary asset (detect it
  with the magic-bytes.js package: zero runtime dependencies, content based
  rather than by extension). Bias to keep, so a malformed evil.js stays a
  candidate and is never silently pruned. A getURL loader is type agnostic, so
  it always stays a candidate.
- Files: the loader scanners (src/parse/loader-files.js,
  src/parse/local-imports.js) extract the template,
  src/lib/reachability.js carries the richer dynamicLoaderSites shape,
  src/lib/util.js gains the canLoad matcher and a loadableAs content
  helper, and src/checks/rules/unused-files.js orphans a file that no site can
  load.
- Variable-indirected loaders. The done work resolves an inline getURL of a
  static path, but not one passed through a binding, for example
   - const popupUrl = getURL("popup.html");
   - windows.create({ url: popupUrl }).
  The url slot holds a variable, so the site stays dynamic and the file stays a
  candidate. Resolving this needs def-use (which static value the binding holds),
  so it rides the TypeScript type-check engine below rather than a hand-rolled
  scope pass here. Note the type checker resolves the binding to its declaration
  but reports its type as string, so a small value step still folds
  getURL(literal) to the path. This is the same value-flow machinery as the
  gated-property permission tracing.


# Re-evaluate fully schema-driven manifest file-ref extraction

Reachability now seeds from a generic manifest string-walk (every string outside
experiment_apis, resolve-gated) in src/lib/manifest-refs.js
(manifestStringRefs) + src/lib/reachability.js. It is simple and
schema-independent, but it is not schema-*driven*: it cannot distinguish a file
reference from a coincidental path-like string, and bundled-files still relies on
the hardcoded manifestFileRefs() list.

The precise alternative is a schema-guided instance co-walk: walk the parsed
manifest against the merged manifest.ManifestBase + manifest.WebExtensionManifest
property types, collecting values whose leaf format is in REL_URL_FORMATS
(ExtensionURL / ExtensionFileUrl = strictRelativeUrl). It would serve BOTH
reachability seeding and bundled-files precisely (no false "missing" nags), and
auto-cover every current + future key (message_display_scripts, compose_scripts,
chrome_settings_overrides favicons, ...).

Requirements / gaps found when scoping it:
- Needs a value-extracting co-walk, not the existing boolean _hasPathLeaf
  (src/schema/index.js).
- _hasPathLeaf does NOT traverse patternProperties / additionalProperties, so
  MAP-typed keys (icons, dictionaries, theme.images -> patternProperties ->
  ExtensionFileUrl) are invisible today; the co-walk must add map handling or
  those regress.
- Coverage becomes coupled to schema freshness: keys the loaded schema omits
  (e.g. theme/dictionaries/sidebar_action are absent from the release-mv3
  bundle's manifest type) would not be extracted. Emit a log() on an unknown
  manifest key so a stale schema is visible rather than silent.
- Relates to the "Improve schema files to remove special hardcoded cases" entry
  (same REL_URL_FORMATS / bridge machinery).
