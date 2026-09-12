# Open work

## The recurring cause (read this first)

Every defect in the purged work was one habit: **deriving a value from a shared
structure without tracing who else reads or writes it, and when.** Tests missed all of
them because they asserted the new code's own output rather than what a consumer saw.
Assert what the consumer sees.

## Open, most important first

## Deferred

- ~~**In SCA mode one VENDOR line exempts a file from EVERY source check.**~~ FIXED
  (`9c86b0a`). The declaration half of `verifyVendor` was extracted as
  `verifyVendorDeclarations` and now runs on the source addon too, so a declared path is
  compared against the bytes its source serves and an entry that does not verify is
  reconciled into the untrusted family - the file is reviewed as the developer's own code.
  The eleven vendor and library checks lost their `sca: false`, so the reviewer is also
  TOLD why. Fixture: `sca-vendor-declared`. The reproduction that opened this entry (a
  one-line VENDOR.md removing an innerHTML finding and a remote-resource ERROR) now
  reports both again.

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
  minimize-web-accessible-resources.

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
  plain Errors, which stay swallowed, which is what all 79 goldens rest on.

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

  This is NOT a downgrade defect: it behaves identically for an XPI-only submission and a
  downgraded one. The downgrade question itself is settled by the rule the plan set - could
  this have been submitted XPI-only, and would we have rejected it? A readable rollup would
  not have been, so no source archive is required. Transpiled source kinds are the one
  deliberate exception (`resolveReviewMode`).

- **Which to-do section a check's cases land in is a property of the CHECK**, declared as
  `escalation: code-review | manual-review` beside its severity - never decided per case.
  A check that would need both sections is asking two questions and is two checks:
  `remote-resources` (what the developer ships) and `vendored-remote-resources` (what an
  upstream release ships) are that split, sharing one scan via `ctx.addon.remoteRefs`. Do
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
  edited routinely and governed 22 checks that fire in no fixture, so it was a live
  gap in something we touch. This is neither. Add the two assertions (`clean` -> 0,
  `all-checks` -> 1) only if that line is ever restructured.

## Where the removed work went

`20d8c79`, `e60702c`, `1e339c6` and `e11723b` are off the branch and reachable by hash
in the reflog; `backup/pre-split` (`95a84f3`) holds the earlier vendor variant. Nothing
is lost, only unshipped. The branch has been rewritten several times since (amends that
folded each audit fix into the commit it corrects), so those hashes resolve through the
reflog rather than by walking the branch.
