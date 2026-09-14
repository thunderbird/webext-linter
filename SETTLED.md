# Settled

Closed decisions and closed questions. Every entry here exists to stop something being
re-litigated: an audit or a fresh reader will find these and call them gaps, and the
reasoning is written down so re-raising one does not cost a round trip.

Open work lives in `TODO.md`.

## The recurring cause (read this first)

Every defect in the purged work was one habit: **deriving a value from a shared
structure without tracing who else reads or writes it, and when.** Tests missed all of
them because they asserted the new code's own output rather than what a consumer saw.
Assert what the consumer sees.

## The analysis-failure rule (read this second)

An analysis can be wrong in two directions and **both are harmful**: a missed guard is a
false rejection, which announces itself - the developer complains, or the LLM catches it -
and an inferred guard is a silent clear, which announces itself to nobody. The second is
worse and easier to miss.

> **An analysis that gives up LOUDLY is safe at any accuracy** - the give-up is an item, a
> reader sees it, nothing is lost. **One that gives up SILENTLY is unsafe at any accuracy**,
> because its failures are indistinguishable from its successes.

That is the test to apply to any new inference, and it cuts both ways: it is why guard
detection was deleted (`guardOf` had "guarded" and "not guarded", and "not guarded" was
acted on as knowledge) and why alias tracing was KEPT (it already has a give-up channel).
The rule is about failure visibility, not about difficulty.

Two corollaries:

- **A give-up test must be positive, not negative.** "Prove it is known, else flag" fails
  loudly. "Flag it if it looks wrong" fails silently.
- **A `code-review` escalation must be answerable from the package alone. If it is not, it
  belongs in `manual-review`.** That is what makes moving work out of `findings` into
  `code-review` a gain rather than a dilution, and a hint that cannot be verified from the
  package is a hint that should not be produced.

A deterministic check may still emit a hard finding, but only when the finding survives
*any* guard the developer could have written. `deprecated-api` passes that test and is the
model, not the exception.

**Fact or inference?** The reusable criterion for auditing a check: does the verdict rest on
a fact or on an inference about what the code does? A fact is a parse result, a file's
presence, a byte or hash comparison, a schema lookup, a literal AST construct, a string
match. An inference decides what code *means*. A fact with an exact anchor is a
deterministic finding; an inference with an anchor is an escalation; an inference with no
anchor possible is a standing sweep. Audited over every registry entry: no check outside the
guard family had a demonstrated defect.

## Decided - do not re-litigate

- **The golden harness fakes the network at the socket, per fixture.** Every fetch goes
  through `fetchWithTimeout` -> `globalThis.fetch`, so the harness replaces that one
  function instead of injecting a transport per stage. An injected transport SKIPS the
  production code above it - fetchWithTimeout, readBytes/readJson, the size caps - which
  then has no golden coverage at all; faking the socket exercises all of it.

  A fixture declares what a URL serves under `network` in its expected.json:
  `{"sameAs": "<path>"}` serves the bytes of one of its own files (the way to express
  "this declaration checks out" without a copy that rots), `{"body": "..."}` literal bytes
  (the way to express "modified"), `{"json": ...}` a JSON endpoint (npm downloads, GitHub
  stars, unpkg ?meta, the OSV audit), `{"status": 404}` an HTTP negative. An UNLISTED URL
  404s - never throws - because a connection-shaped error sends fetchWithTimeout into
  assertNetwork, which can abort the review (NetworkGoneError). A fixture wanting that
  declares it. The mock is installed and restored per fixture, so one fixture's URLs never
  answer another's.

  This is what made the vendor system's success path reachable: `verified-vendor-source`
  (bytes match, popular -> exempt, nothing reviews the file), `vendor-modified` (bytes
  differ -> reject, that check's first golden), `not-popular-vendor-source` (bytes match,
  under the download bar -> reject, which pins the "only popular libraries are trusted"
  rule), and `vendored-remote-load` (a verified stylesheet whose own line loads a remote
  font -> Extended manual review). Before it, every fixture could only ever reach
  "unfetchable".

  `vendor-vuln-unknown` and three more complete the set: a GitHub-sourced file that verifies (trusted,
  pinned, bytes match, repo over the stars bar) and is therefore exempt - but an OSV audit
  needs an npm NAME, and a GitHub URL carries none, so auditGithub tries to prove one by
  hash-matching the bare repo name against that npm package. When that package does not
  exist, no audit is possible and the check says so. Every outcome verifyUrl can return is
  now covered by a golden, and so is every network-dependent check: `vendor-vulnerable`
  and `vendor-vulnerable-dev` (an OSV advisory), `unpopular-source-dependency` (a declared
  dep under the download bar) and `find-lib-on-cdn` (the jsDelivr content lookup, which a
  fixture opts into with `"options": {"--cdn-lib-lookup": "true"}`).

  Two things that cost a debugging round and are worth not repeating. The CDN identifier
  WRITES its results back, so `fixtureCacheOpts` had to point `cdnLookupCache` at the
  throwaway dir too - a fixture was polluting the repo's real `.lib-cdn-lookup-cache`, and
  then passing from that cache, which hid a broken lookup. And `lookupHash` returns
  `{state, hit}` where the caller only reads `state` for `"error"`: mutating the state to
  "miss" does NOT discard the hit, so a mutation test has to attack `hit`.

  Eight checks still never fire in any golden, all offline and unrelated to the network:
  trademark-violation, manifest-invalid-json, manifest-missing, unsupported-dependency,
  disguised-stylesheet, csp-unsafe-eval, csp-unsafe-inline,
  minimize-web-accessible-resources. Measured, not assumed: the two
  trademark-thunderbird-* checks DO fire, in fixtures added with the trademark split, but
  `trademark-violation` needs a brand term that no fixture ships. Note an escalation is
  observable only in the `.txt` golden, because `expected.json` diffs findings alone.

- **A dead network aborts the review; one dead load does not.** Every catch in the vendor
  and CDN paths turns a fetch failure into a benign value ("not popular", "unfetchable",
  no CDN match). That is right for one load failing and wrong for a dead route, where it
  silently reclassifies a popular library as the developer's own code and the report reads
  like a clean review of a different add-on. `assertNetwork` already tells the two apart
  with a control-point probe, so each swallow site only has to not eat the answer
  (`rethrowIfNetworkGone` in `src/util/net.js`).

  A 404 or a timeout is NOT this - something answered, and the benign fallback stands.
  `npmDownloads` keeps its null-vs-number distinction for the same reason, so
  `unpopular-source-dependency` still never rejects on a flaky lookup. An INJECTED
  transport says nothing about the real network either: the offline fixture harness throws
  plain Errors, which stay swallowed, which is what all 88 goldens rest on.

  The guard is at the entry points, not the catches: a test injects a NetworkGoneError and
  asserts it propagates out of verifyVendor, verifyVendorDeclarations,
  verifyScaDependencies, isPopular and resolveCdnLibraries. That is what catches a new
  swallow site forgetting the rule.

- **A bundled (rolled-up) build defeats library identification, and that is accepted.**
  Every path that recognises third-party code is content-hash based - the Mozilla hash DB
  (`missing-library`), the jsDelivr lookup (`find-lib-on-cdn`), the byte compare against a
  declared source (`vendor-modified`). A bundler rewrites the bytes, so a rollup output
  matches nothing, and `vendor-vulnerable` can only audit what it can NAME: declared
  package.json deps (an XPI ships none) or hash-identified files (there are none).
  Verified: a readable, unminified rollup with two inlined dependencies reports "did not
  find any issues".

  What is lost is the ADVISORY AUDIT, not the review - the whole bundle is read as the
  developer's own code, which is the strictest treatment there is. Asking for the upstream
  source does not help, because we cannot identify what was rolled up in the first place;
  that is why declaration is not required here.

  It behaves identically for an XPI-only submission and for one accompanied by a source
  archive, because the review is never re-routed by what the XPI looks like.

- **A source archive is NEVER traded away for the XPI.** An SCA submission is always
  reviewed as SCA (`resolveXpiOnlyAdvice`). The older rule - "could this have been
  submitted XPI-only, and would we have rejected it? a readable rollup would not have
  been, so no source archive is required" - downgraded the review on that answer, and was
  wrong twice over. It asked whether the shipped bytes could be READ, not whether they
  WERE the source, so every bundler submission (webpack, Vite, a build copying from
  submodules) was told its archive was unnecessary; Thunderbird Conversations was rejected
  for a `new Function` in webpack's own `globalThis` polyfill, code its developer never
  wrote and could not edit. And no content test can be trusted to route: a committed,
  unminified `dist/` inside `--sca-source` is its own twin under any of them, so a build
  can always be dressed up as source.

  The three questions survive as ADVICE only (`sca-not-required`, info): readable bytes,
  no transpiled source kind, and every shipped script byte-identical to one in the archive.
  A wrong answer now costs a wrong suggestion, not a narrowed review - which is what makes
  the third question safe to ask at all.

- **Which to-do section a check's cases land in is a property of the CHECK**, declared as
  `escalation: code-review | manual-review` beside its severity - never decided per case.
  A check that would need both sections is asking two questions and is two checks:
  `remote-resources` (what the developer ships) and `vendored-remote-resources` (what an
  upstream release ships) are that split, sharing one scan via `getRemoteRefs` (cached on `ctx.addon.remoteRefs`). Do
  not reintroduce a per-case flag to save an entry, and do not merge those two checks'
  wording to save a key: one asks "is this even remote", the other "does the add-on need
  this file at all".

- **Only popular libraries are trusted; everything else is the developer's own work**
  and gets the full review every other file in the submission gets. That is the base
  concept, not a threshold to tune. So `verified` (which ends
  `isPopular(...) ? "verified" : "not-popular"` on all four verification paths) IS the
  right test for "this line is not the developer's", and the questions that follow from
  it are answered by it: that the popularity bar decides whether a remote load is a
  reject or a reviewer judgement is the point, and a content match against a popular
  package's published file is trusted whether or not the developer declared it - the
  bytes are that library's either way. See [[the JS lane's vendored skip]] below for the
  one place the same conclusion is reached by declaration instead.

- **The JSON report is an upload filter, and carries only what we are 100% sure of.**
  A machine reads it and can REJECT a submission outright, so an add-on rejected there
  never reaches a reviewer. `formatJson` therefore omits `meta.manualReview` by design
  and the exit code counts findings only. Moving a case from a finding to manual review
  is not a lost signal - it is how the submission stops being auto-rejected and reaches
  a person instead. Do not "restore" such an item to the JSON as an info finding: that
  puts something uncertain into the filter, which is the one thing it must not carry.

- **`unused-files` is a `warning`, so a false positive cannot filter an upload.** Severity is
  the one thing that decides whether a finding rejects a submission, and a deterministic
  unused-files hit can still be wrong - a file reached by a loader the scan could not follow
  is reported as unused. As an `error` that wrong answer auto-rejected the submission through
  the JSON filter, which is the one thing the filter must not do. Demoting it keeps the
  finding in the report and in the JSON, where a reader and a developer both still see it,
  and takes away only its power to reject. Do not restore it to `error` because "an unused
  file should not ship": that is true, and it is what the warning says.

  The general lever: where a deterministic finding can still be wrong, the fix is its
  SEVERITY, not removing it from the JSON - see the upload-filter entry above for why the
  report must still carry it.

- **Vendor sources compare as written**, never normalised. Normalising caused a
  verification bypass (`http://` first won the collapse, so the file was never fetched)
  and a false positive (unpkg `?module` serves different bytes from the same path).

- **One file, one source.** A path declared twice with different URLs refuses the
  whole file: keeping either would leave the other unverified with nothing said about
  it. An identical repeat is not a contradiction and collapses to one entry.

- **A declared path is a path from the package root.** A bare filename means that file
  at the root; the parser does not hunt for it by basename. Not finding it is reported
  by `missing-vendor-file`, not repaired by guessing.

- **The JS lane's vendored skip stays declaration-based**, not verification-based. A
  declared-but-unverified file is already gated by `vendor-modified`,
  `unpinned-vendor-source` and `vendor-unverified`, so the declaration alone never gets
  anything past review.

- **In SCA mode a VENDOR declaration does not exempt a file from the source checks**
  (`9c86b0a`). The declaration half of `verifyVendor` is `verifyVendorDeclarations` and
  runs on the source addon too, so a declared path is compared against the bytes its
  source serves, and an entry that does not verify is reconciled into the untrusted
  family - the file is reviewed as the developer's own code. That is why the eleven
  vendor and library checks are no longer gated out of an SCA review: the reviewer is also
  TOLD why.
  Fixture: `sca-vendor-declared`. The reproduction that opened this - a one-line
  VENDOR.md removing an innerHTML finding and a remote-resource ERROR - reports both.

- **`experiment-unknown-api` stays, and the namespace collision it raises is already
  gated.** It covers an unknown NAMESPACE - a schema declaring `namespace: "mytools"`
  while the code calls `myTools` - which is a typo in the developer's own schema rather
  than a non-existent API, and its locus-less reminder is the only thing that says so.
  Registering an Experiment schema's MEMBERS (open, see `TODO.md`) does not touch that
  case. The collision is gated too: `experiment-overrides-api` is an ERROR that rejects
  an Experiment extending or replacing a built-in namespace, so a developer declaring
  `namespace: "messages"` cannot merge their types over a built-in one.

- **Manifest file references come from the schema, and `manifestStringRefs` stays beside
  them.** `manifestFileRefs(manifest, schema)` walks the parsed manifest against its schema
  type across all five `MANIFEST_ROOT_TYPES` and takes leaves whose `format` is in
  `REL_URL_FORMATS`, replacing a hand-kept key list that had silently forgotten `icons`.
  `manifestStringRefs` was NOT replaced by it: it answers the opposite question - every
  string, filtered by existence, for reachability seeding - and emits no findings, so the
  two do not double-report. Coverage can now narrow silently if a key is retyped upstream as
  a plain string, and per-key detection would need the very list the walk deleted, so the
  tripwire is a drift lock against the real cached branches in `tests/unit/schema-index.test.js`.

- **A known false positive is produced and withdrawn, not suppressed.** Where a check would
  have to learn an inference to avoid a false positive, it keeps emitting the finding and the
  `--llm-review` withdraws it with the file in front of it. Teaching the check the inference
  is the move that fails silently - see the analysis-failure rule - so the residual false
  positive is the accepted cost. The bounded exception is the agent-less path: a finding
  reaches the JSON upload filter, which has no withdrawal step, so this trades a reviewer's
  minute against an occasional wrong auto-rejection, deliberately.

  The instance that raised it: `missing-permission` reports a bare property read used as
  feature detection. An add-on declaring only `storage` whose background does
  `if (messenger.messages.listInlineTextParts)` and never calls it reports
  `background.js:2 - messages.listInlineTextParts needs 'messagesRead'`. It is also less of a
  false positive than it looks, because the legitimate pattern is already covered: an
  OPTIONAL permission counts as declared, so `optional_permissions: ["messagesRead"]` with
  the same guard passes and is not reported unused either (verified). What fires is an add-on
  that declares the permission nowhere and therefore cannot reach that API at all.

- **Guard detection was dropped entirely**, not reduced to its sound parts: after the
  routing change a 100%-correct detector decides exactly as much as a 0%-correct one, and
  unused analysis code with a plausible purpose is how a gate returns in two years. The
  shim skip went with it, because `guardRefs` was `guardOf`'s return value and could not be
  kept alone. `optional` survives as a syntactic chain fact. The `guardOf` function boundary
  was not the mistake - the mistake was letting a conservative answer drive a rejection
  instead of a review.

- **Do not re-add detectors for the guard idioms, do not tighten a `debugger` guard test,
  and do not teach the alias tracer more binding forms.** Each addition makes the analysis
  feel safer while the next shape stays unhandled.

- **Alias tracing is not the same class as guard detection and stays.** The API-resolution
  checks all resolve through `resolveApiUsages`; without it an add-on writing `const api = browser` becomes
  invisible to all of them, `missing-permission` included. That is an evasion path, not a
  coverage gap.

- **`deprecated-api` stays a deterministic finding.** A deprecated API still exists and
  still runs, so no construction around the call makes the migration note moot - there is
  no judgement to get wrong, which is what a finding requires.

- **Escalation volume is a non-issue - measured.** Across 87 golden fixtures at the time:
  `strict-min-version-api` 5 hard findings / 4 fixtures, `unknown-api` 7 / 4,
  `debugger-statement` 2 / 2 - fourteen items over roughly eight fixtures. Across four real
  add-ons, exactly one item moved.

- **No new grouping mechanism is needed for escalations.** The `entry` collapse already does
  it: the message is written once per registry entry, hits are listed as file:line hints
  beneath it, and the items JSON gives each hit its own index so it carries its own verdict.
  The granularity already matches the unit of judgement. Rendering also works with zero
  findings: an entry carrying an `escalation` renders correctly when its check emits none,
  which is how `unused-permission` (`severity: warning`, `escalation: code-review`) already
  behaves.

- **`minified-code` is a deterministic finding, and that is the right row.** It was raised as an
  inconsistency with `obfuscated-code`, which was later made deterministic too - both now
  carry `severity: error` and no `escalation`. The
  detection is a pinned structural match better calibrated than "heuristic" suggests -
  statement density on the packed line (`MINIFIED_LINE_STMTS = 10`, `LONG_LINE = 500`),
  chosen to separate packed code from data literals, with measured headroom (false-positive
  shapes top out at 4) - and its miss direction is benign, because a missed file is simply
  reviewed as authored code.

- **The guard-signal plan is fully disposed of.** Its A, B and C shipped (`f75fd27`):
  `strict-min-version-api` and `unknown-api` escalate every site, `debugger-statement`
  escalates every statement, and the guard signal itself is gone. D was dropped, because
  the `--llm-review` prompt already requires a reason for every verdict. I was superseded
  by the per-check `sweep-instruction` work, which files what a reader finds under the
  check's own id and band instead of under a locus-less sweep's. G is answered: the
  `disguised-*` family keeps `severity: error` and declares a sweep rather than
  escalating, and its `strict-max-version-api` wording item is moot with no guard signal
  left to word. H's first half is the eval-scan false positive, carried into `TODO.md`;
  H's second half was withdrawn, because the `unused-permission` warning it complained
  about is hedged and offers its own escape hatch, and the fix would have added an
  escalation to every add-on with an unfollowable loader. E and F are closed by the
  TypeScript entry below.

- **`--sca-source` and `--sca-exp-source` are paths relative to `--sca-root`, never
  absolute.** Both name a folder INSIDE the extracted source; an absolute path names a
  folder on the reviewing machine, which can be anywhere, so what it names is not part of
  the submission and cannot be shown to be. `--sca-root` itself is a machine path and stays
  free. Refused at the CLI with a usage line and in `scaRootRelative`, so no caller has a
  second answer; `.` and `./` still name the root itself. Do not re-add the absolute form.

- **The order authored in `llm-manual-review-choices` IS the order a reviewer sees.** It is
  the only rule about answer order: no prompt step, no code and no second list may restate
  it, because a rule kept in two places is a rule kept in step by hand. Reordering the yaml
  reorders what every question offers and what each position settles, and a test pins that
  by flipping the list and asserting the outcome flips with it. Do not re-add "always offer
  X first" wording anywhere.

## Not needed - do not re-report

An audit will find these and call them gaps. They were looked at and judged not
worth the change. Re-raising one costs a round trip, so the reasoning is here.

- **An AMBIGUOUS vendor source leaves its files unscanned, and that is fine.** One URL
  declared for two files cannot verify either, so `resolveVendor` drops both entries from
  the manifest while keeping their paths in the skip set (`resolve.js`: "still vendored,
  just unverifiable"). Those files are therefore exempt from content review - verified:
  two files each doing `innerHTML`, one also importing a remote payload, produce neither
  finding, in an XPI review as much as an SCA one.

  It is NOT a bypass, because `vendor-ambiguous-source` is an ERROR: the submission is
  rejected in both modes, the developer must give each file its own source, and on the
  next submission both files are verified and scanned normally. An unscanned file can
  never be part of an ACCEPTED submission, which is the only thing that would matter. Do
  not "fix" the skip set here.

- **The CLI exit code is unpinned between 0 and 1.** `cli.js` ends
  `return hasErrors(result.findings) ? 1 : 0`, and mutating it to a constant `0`
  or `1` passes the whole suite. A mutation audit will report this as the
  highest-consequence trivially-true assertion, because JSON is an upload filter
  and a wrong exit code auto-rejects everything or nothing.

  It is correct today, and consequence is not likelihood: one obvious expression,
  in one file, that nothing else reads. `cli.test.js` does assert the code is one
  of `[0, 1]`, so a crash or a stray `return 2` is still caught - only the 0-vs-1
  discrimination is open. Contrast the severity map, which IS pinned: severity is
  edited routinely and governs the eight checks that fire in no fixture, so it was a live
  gap in something we touch. This is neither. Add the two assertions (`clean` -> 0,
  `all-checks` -> 1) only if that line is ever restructured.

- **`obfuscated-code` swallowing a per-detector exception is fine.** The audit's own test -
  a fact may be a finding only if "I could not tell" is a state it can reach and report -
  was put to it, and measured over 15610 JS files from the corpus XPIs and source archives.
  Of the three ways it can fail to judge a file, two are already loud: a pinned family the
  library no longer ships throws with exit 2, and a real file that does not parse is a
  `minified-code` error. The third, one detector throwing on this input, is logged at debug
  and read as "this family did not match".

  That third case fires on **2 files in 15610**, and both are plainly readable code - a
  104-line commented ES module (1 family unanswered) and a 122KB hand-written script with a
  10540-character data line (4 unanswered, all the `array_*` family). Both PASS on the
  merits, so no verdict was concealed, and the detector demonstrably still works: two other
  corpus files do FAIL. The parse-failure path never fired on real JavaScript at all - all 45
  hits were `__MACOSX/.../._*.js` AppleDouble resource forks of 163 to 237 bytes.

  Making the throw fatal was tried and reverted: it rejected two published add-ons with exit
  2 and no report. Making it a visible limitation would put a reviewer-facing note on
  legitimate add-ons at the same rate. The known residual is adversarial rather than
  accidental - source crafted to crash the array detectors dodges those four families
  silently - and what bounds it is that such a file still faces `minified-code`. Re-open this
  only for that evasion, and with a visible limitation, never a fatal error.

- **`unused-files` escalating every ambiguous file is the design, not a gap.** Once an add-on
  builds any load path at runtime, the check cannot tell whether a computed path reaches a
  given file, so it escalates rather than risk missing a file that should not ship - the
  false-positive-over-false-negative trade above. Measured over the corpus: 74 of 407 add-ons,
  397 items, 98 of them on one add-on. That volume is the price, not a defect. The JSON
  omission is not a hole either: escalations are stripped from the upload filter by design and
  the submission reaches a person instead, per the upload-filter entry above.

  One dynamic loader does disable the deterministic path for EVERY file in the add-on, so a
  file that loader provably cannot reach - wrong directory, wrong extension, wrong slot type -
  escalates where it would otherwise be a plain finding. Closing that was scoped (anchored
  path templates per loader site, a `canLoad` matcher, a magic-bytes content check) and
  dropped: it buys precision in a check where judgement is the accepted answer, for a
  five-part change across the loader scanners, reachability and the check. Do not re-raise the
  escalation volume as a blind spot.

- **The sink list has no `unrecognized-file-type`-shaped backstop, and cannot have one in
  that shape.** The file-suffix backstop works because referenced files are a closed,
  enumerable population and the unknown is an attribute of an observed member. Outbound
  sinks have no observable population short of every call expression, so the standing sweep
  stands at full size. Do not re-ask this.

- **Reachability dropping a file it could not follow does not hide anything dangerous.**
  Sink, DOM and eval scanning run over the authored corpus rather than the reachable set,
  and the permission half has the manifest witness. The harm is a false positive, not a
  bypass. Do not re-open it as a security question.

- **Recording the verdict reason in the verdict file is dropped.** The `--llm-review` prompt
  already demands a reason for every verdict and every withdrawal, and it reaches the
  reviewer before they accept it, which is when it can change an outcome. Writing it to the
  file only buys a later audit of a sample of clears, and that sampling is not going to
  happen - which the proposal named as its own precondition. Do not re-propose it without
  someone committed to doing the sampling.

- **`eval` is scanned in every non-vendored file.** The scan once skipped
  `pureWebExtensionReachable` on the reasoning that a WebExtension page cannot run `eval`
  without a permissive CSP, and that `csp-unsafe-eval` reports that CSP on its own. That
  scoping is dropped: authored files are scanned, vendored and library files are not, and no
  CSP or reachability condition gates it. Do not reintroduce a scoping condition here - not
  the WebExtension skip, and not a `privileged || the CSP permits eval` variant, which was
  explored and rejected.

- **A TypeScript type check is not worth adopting, in either form proposed.** Both were
  judged on whether they clear an entire check of false negatives.

  A *full type check* clears no existing check: neither any check nor any of the eight
  `sweep-instruction` entries covers API misuse (argument shapes, return-value structure),
  so it would be new capability rather than a closed gap. And it cannot be FN-free by
  construction. Against its own canonical example - `messages.query` returning a
  `MessageList`, not an array - `tsc` with `allowJs`/`checkJs` and no `noImplicitAny`
  reports all three misuses on a directly typed receiver and NONE of them once the same
  value passes through one untyped parameter or an untyped object property.
  `--noImplicitAny` does not recover them: it emits four diagnostics, none of which is one
  of the three bugs, all of them complaints about the developer's own untyped style. The
  setting that makes the tool usable is the one that makes it blind, and it goes blind
  SILENTLY - no diagnostic, no "I could not tell". Misusing an API is also a functionality
  bug, which the review already covers by testing in a profile.

  *Permission tracing* fails on its data, not its idea. A type checker supplies the
  receiver's type; the gate table has to come from the schema, and in release-mv2 the
  functions carry 54 machine-readable `permissions` and 0 prose-only, while the properties
  carry 4 machine-readable and 31 PROSE-only - `<permission>X</permission>` inside a
  `description`. Its own canonical caveat, `menus.OnClickData.attachments`, is one of the
  prose ones, so there is nothing to look up. On the corpus (394 of 407 XPIs, 13 skipped
  for no root manifest or an unparseable one) the false negative is zero: 28 textual
  candidates collapse to 8 add-ons, of which four read the property in privileged
  Experiment code, which permission accounting excludes by design (`src/lib/permissions.js`);
  one is a Yandex credential field that happens to be called `folderId` rather than
  `messages.query`'s; one is already reported two lines later by the FUNCTION gate
  (`messages.get needs 'messagesRead'`, the general pattern being that a gated property is
  read in order to feed a gated function); and one is rejected earlier by
  `experiment-not-allowed` and never reaches the check.

  Two sub-decisions from the abandoned plan go with it and need no separate answer: that the
  type layer cannot be lied to (we would control the typings and the file list, so no
  submitted `.d.ts` enters and a JSDoc assertion fails assignability, leaving only a double
  cast through `any` as a grep), and that the TS coverage-gap walk was dropped for localising
  the alias blind spot rather than closing it. Both are moot with no type layer.

  So there is no reason to consume `webext-typings-generator` output during a review. Its
  own defects stay bugs in that repo - `chrome` is not declared, and
  `.out/messenger-mv2.d.ts` does not compile (one error, `Cannot find name
  'ContextFilter'`). What survives is upstream and has nothing to do with types: promoting
  those 31 prose gates to a machine-readable `permissions` field, which `TODO.md` carries.

- **What a review leaves out is a SKIP, not a second review flag.** `--llm-verify` was one
  flag meaning "withhold both the parts that need a person"; it is now `--llm-skip-summary`
  and `--llm-skip-manual`, each naming one part, and both requiring `--llm-review`. A
  reviewer who wants the description but not the questions, or the questions but not the
  description, can say so - and giving both is what the old flag was. The prompt's steps
  declare which skip withholds them (`skip: summary` / `skip: manual`), so the flags, the
  yaml and the renderer agree through one list (`PROMPT_SKIPS`, `src/config.js`)
  rather than through a mode word.

  A mode VALUE on `--llm-review` is still refused, for the reason the old entry gave: that
  flag takes no value - the item file is the linter's to name - so a mode word could only
  arrive as a POSITIONAL, and that slot belongs to the add-on.

  Two shape decisions go with it. The prompt's `outcome` is an ARRAY of steps, each
  optionally marked with the skip that withholds it, rather than authored variants of one
  scalar: the variants would duplicate ~60 lines of the highest-value prose in the repo and
  drift. A step with no marker is printed by every run, the builder numbers the survivors,
  so no step may number itself, and anything one skip drops is either worded neutrally or
  lives in a step that skip withholds - that is why the "do not describe the add-on
  yourself" and "their answers need no report" clauses sit in the dropped steps rather than
  in the surviving ones they used to qualify.

  And a skip omits what it withholds from the ITEM FILE as well as from the prompt, rather
  than listing items it never asks about. That is safe because the manual sections are the
  last ones `orderReview` numbers, so the file truncates rather than developing a hole: an
  index means the same item in a cut-down file, a full file and the report alike, and
  `applyVerdicts` resolves it against the full ordered review either way.

  Both skips may also be given to `--llm-sca-review`, which prepares a review rather than
  printing a prompt of its own: it hands them back in the command it prints. `--llm-verdict`
  takes neither - it prints a settled report, not a prompt - so the round trip's last step
  says to drop them along with the review flag.

- **A reviewer's note is not carried past the per-entry display cap, and that is fine.** An
  entry prints at most `MAX_ENTRIES_PER_CATEGORY` locations, so the note on a 26th case of
  one check is asked for, answered, and never printed - the very loss `readVerdict` refuses
  for a `cleared` verdict. It stays: a submission with 26 cases of one manual check is
  rejected long before a reviewer works through 26 questions about it, so the path is not
  one a real review reaches. Do not re-propose exempting notes from the cap, sorting noted
  members to the front of the shown window, or warning about it.

- **A noted case with NO location of its own leaves its entry, and that is wanted.** A note
  makes an item locus-bearing (`hasLocus`), and locus status is part of the grouping key,
  so a noted locus-less case is listed on its own rather than inside the entry its unnoted
  siblings share. The alternative is a numbered entry whose location list mixes cases a
  reviewer wrote about with cases they did not. A case that HAS a location still groups
  normally - the note is on the location line, not in the text entries group by. Do not
  re-propose computing the grouping key from the item's own locus fields.

- **A note identical to something already on its location line is dropped.** `locationLine`
  drops a segment equal to one already printed, and that applies to a note as much as to a
  subject that is its own path. A reviewer who answers with the hostname the line already
  names has added no information, so none is lost. Do not re-propose exempting notes from
  the dedup or diagnosing the drop.

- **The item file is not hardened against a local attacker.** It is written to the system
  temp directory under a name built from the submission's own manifest, and the run claims
  it by writing an empty string - which follows a symlink, so a path pre-created by someone
  else is truncated rather than refused. The run's timestamp is in the name to keep two
  reviews apart, not to make the name unguessable. Guarding it (an `O_EXCL` claim, or a
  `mkdtemp` directory per run) is not worth doing: the attacker it protects against is
  already running as the reviewer on the reviewer's own machine. Do not re-propose it.

