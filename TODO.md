# Table of Contents

- [Defects, false-positive and false-negative (WIP)](#wip)
- [Hash-based library identification](#hash-based-library-identification)
- [Detect correct schema reference](#detect-correct-schema-reference)
- [Improve schema files to remove special hardcoded cases](#improve-schema-files-to-remove-special-hardcoded-cases)
- [Full type check via typescript engine](#full-type-check-via-typescript-engine)
- [Potential permission tracing via typescript engine](#potential-permission-tracing-via-typescript-engine)
- [Unused-files pre-flight backstop (anchored templates + content type)](#unused-files-pre-flight-backstop-anchored-templates--content-type)
- [Single-parse extraction pass (drop the double-parse)](#single-parse-extraction-pass-drop-the-double-parse)


# WIP


- (check build types)

---

unsafe-html on DOMPurify-sanitized innerHTML (warnings): markdown-here (3×) and attachment-image-viewer (2×) assign innerHTML = DOMPurify.escapeHTML/sanitize(...); the check can't trace the sanitizer. Lower priority (warning, conservative-by-design), but a clear precision opportunity.

---

Approach to be able to get summary of large add-ons

Two large add-ons (cardbook, grammar) are beyond the LLM size limit.


# Hash-based library identification

We currently use a popularity system to identify popular and well-maintained
libraries. We should however also be able to allow-list libraries via a hash,
and also use the same hash system to block certain libs, which are deemed unsafe.

# Detect correct schema reference

Evaluate if a submission which is limited to 140.* (ESR) should be verified against the ESR schema, or the standard release schema.

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
  src/checks/lib/reachability.js carries the richer dynamicLoaderSites shape,
  src/checks/lib/util.js gains the canLoad matcher and a loadableAs content
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

# Single-parse extraction pass (drop the double-parse)

The OOM crash on bundle-heavy add-ons is already fixed (commit 81ef546):
buildRunContext frees the AST of every non-authored file (the multi-MB minified
bundles), so peak memory is bounded. This is the follow-up optimization that was
deferred there - it is NOT a correctness fix, the crash is gone. Two structural
inefficiencies remain:

1. Double-parse of authored JS. `classifyBundled` (the pre-normalize pipeline
   step) parses each non-minified, non-library JS file once to compute the
   AST-based obfuscation signal (`detectObfuscationAst`, src/checks/lib/
   bundled.js), and then `buildRunContext` (src/checks/context.js) parses every
   JS file again for api-usage and the checks' `src.parsed`. So an authored
   non-minified file >= 1024 bytes is parsed twice per review.

2. Authored ASTs are still all retained at once. The pipeline is check-major -
   each of the ~10 AST consumers (eval-scan, outbound-sinks, core-symbol-in-
   webext, sync-xhr, debugger-statement, async-onmessage, remote-script,
   unsafe-html, background-page-module, plus api-usage) loops every file and
   re-traverses `src.parsed` - so each authored file's AST must stay alive across
   all checks. Memory is bounded today only because the big files happen to be
   bundles (now freed); a pathological add-on with many large *authored* files
   could still strain the heap.

Both follow from the same root: the obfuscation signal is needed by
`classifyBundled` (which builds the non-authored skip set) *before*
`buildRunContext` does the main parse, and the checks consume `src.parsed`
lazily during the review rather than reading a precomputed result.

Idea (the extract-then-free pass). Parse each file exactly once, up front, and
run every per-file AST extraction in that one pass, storing only the small
extracted results on the source; then drop the AST (so peak memory is a single
AST, authored or not). Concretely:

- Reuse the existing standalone scanners as extractors: `parseApiUsage`
  (api-usage.js), `scanRemoteJs` (remote-js.js -> eval-scan + remote-script),
  `scanNetworkSinks` (network-sinks.js -> outbound-sinks), the unsafe-html
  scanner (parse/unsafe-html.js), and `detectObfuscationAst` (bundled.js).
- Extract the currently-inline traversals into standalone `src/parse/*` scanners
  and call them in the same pass: core-symbol globals, sync-xhr `open(...,false)`,
  debugger-statement, async-onmessage, background-page-module.
- The ~10 consuming checks + `getEvalScan`/`getOutboundSinks` then read the
  precomputed per-file results instead of re-traversing `src.parsed`;
  `classifyBundled` reads the precomputed obfuscation signal instead of parsing.

Ordering / caveat. The obfuscation signal feeds `classifyBundled`'s nonAuthored
set, which is pipeline step 1d (pre-normalize), before the review context. So the
single parse has to move ahead of `classifyBundled` (parse-first, then classify
with the signals already available), or `classifyBundled`'s obfuscation result is
merged in right after the shared parse. Whichever way, `classify()`'s minified /
library detection is byte-geometry and MUST stay pre-normalize (that is the whole
reason classifyBundled runs before normalize - see its header comment), so the
reorder must keep the byte signals on the pre-normalize bytes and only let the
AST-obfuscation share the one parse.

This is a sizeable, behavior-preserving refactor (~10 check consumers +
context.js + bundled.js + a few new src/parse/* scanners). Land it
consumer-by-consumer with the 41 golden + unit suite green at each step; the
end state removes the double-parse and bounds memory to one AST regardless of how
much authored code an add-on ships.
