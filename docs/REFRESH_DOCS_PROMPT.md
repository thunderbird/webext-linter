# Refresh the check documentation site

This is a prompt you can "run" by pasting it to Claude Code (or any capable
coding agent) from the repository root. It regenerates / updates the static
documentation site under `docs/` so it stays in sync with the checks the tool
actually implements.

Unlike the initial bring-up, this refresh is **not** limited to the first 10
checks — it must cover **every** check the tool runs.

---

## The task

Update the static documentation site in `docs/` so that it documents **all
implemented checks**, each with a human-readable decision flowchart. Add pages
for new checks, update pages whose logic changed, and remove pages for checks
that no longer exist.

## How the site is built (do not change the architecture without being asked)

- Pure static HTML/CSS — **no build step**, opens directly via `file://`.
- `docs/index.html` — the shell. A left sidebar lists every check (grouped by
  category) plus a leading **Review** category with the two whole-review flows,
  and the right pane is an `<iframe>` that loads the selected page. The check
  list is a hand-authored `CHECKS` array in an inline `<script>`; the two review
  flows are a hand-authored `REVIEW_PAGES` array combined with `CHECKS` into
  `NAV`. Each nav entry may carry an explicit `file` (relative to `docs/`);
  checks default to `checks/<id>.html`. Selection uses `location.hash` for
  linkable pages, and the default landing page is the Standard review flow.
- `docs/assets/style.css` — shared styling for the shell and the check pages.
- `docs/assets/mermaid.min.js` — Mermaid, **vendored locally** (offline). Do not
  switch to a CDN.
- `docs/checks/<id>.html` — one standalone page per check.
- `docs/review/<name>.html` — one standalone page per whole-review flow
  (`standard.html`, `sca.html`). Same page template as a check page, but they
  document a review *mode* rather than a single check, so their flowchart walks
  the pipeline stages, not one check's branches.

## Sources of truth (read these to (re)generate content)

1. `assets/registry.yaml` — the canonical list of checks, in order, with each
   check's `title`, `severity` (`error` / `warning` / `info`), `check` (the
   kebab-case id), `response` (developer-facing message), and often a leading
   comment block describing intent. Some entries have no `severity` (manual /
   producer checks) or special fields (`phase`, `diff`, `summary-prompt`,
   `permission-recheck`). The check-bearing sections are `deterministic-checks`,
   `llm-checks`, `manual-checks`, and `post-summary-rechecks` — the last holds every
   recheck CONSUMER (the target of a producer's `post-summary-recheck:`), which is
   re-judged by the `--llm-review` summary and declares no `input`.
2. `src/checks/rules/<id>.js` — the implementation of each check. The header
   comment block describes the decision logic in prose; the `run()` body is the
   ground truth for the branches. Shared logic lives in `src/checks/lib/`
   (e.g. `permissions.js`, `reachability.js`) — read those when a rule delegates
   to them.
3. `README.md` — overall framing (deterministic vs LLM vs manual checks, the
   `--llm-review` recheck mechanism, producer/consumer pairs), and the
   **Standard** vs **Source code archive (SCA)** review modes.
4. `src/pipeline.js` — the review pipeline (`runPipeline` / `reviewAddon`): the
   ground truth for the two whole-review flow pages. It shows the stage order
   (load → experiment classification → setup/vendor → schema/parse → run checks →
   summaries → recheck → report) and the `mode === "sca"` forks (the source /
   dependency / build / shipped-XPI / shipped-manifest split, routed via `routeCtx`
   through `buildShippedCtx` / `buildScaBuildCtx` / `buildManifestCtx`).

## Steps

1. **Enumerate checks.** Parse `assets/registry.yaml` to get the full ordered
   list of checks and their metadata. Cover ALL check-bearing sections -
   `deterministic-checks`, `llm-checks`, `manual-checks`, and `post-summary-rechecks`
   (do not miss the recheck consumers in that last section) - noting the section each
   lives under and any check with no severity (manual-review / escalation producers).
2. **Diff against the site.** Compare that list to the `CHECKS` array in
   `docs/index.html` and the files in `docs/checks/`. Identify: new checks (need a
   page), removed checks (delete the page + sidebar entry), and existing checks
   whose `.js` logic or registry metadata changed (refresh the page).
3. **Author / update one page per check** at `docs/checks/<id>.html`, following
   the existing page template exactly (see any current page, e.g.
   `docs/checks/core-symbol-in-webext.html`). Each page has:
   - a header with the check title, a severity `badge`, and the `check` id;
   - a **What it detects** section: 2-4 sentences of plain English, **no code**,
     derived from the `.js` header comment + the registry comment/`response`;
   - a **Decision flow** section: a `<pre class="mermaid">` `flowchart TD` that
     walks the check's *real* decision path — scope/skip conditions as the first
     gates, decision diamonds for each branch, and terminal nodes for the
     outcomes (`no finding` vs `ERROR` / `WARNING` / `INFO`, or an escalation to
     manual review). Reuse the shared `classDef` styles (`err` / `ok` / `info` /
     `skip`) used by the existing pages so colours stay consistent;
   - an **Outcome** box paraphrasing the registry `response`;
   - a **source-note** footer pointing at the `.js` file and registry.
4. **Handle the special cases** the registry encodes:
   - checks with no `severity` (manual review) — use a neutral badge and let the
     flowchart terminate in an "escalate to manual review" node rather than an
     error/warning/info;
   - producer / recheck pairs (e.g. `*-manual` → its consumer, or the
     `--llm-review` rechecks) — describe the escalation and where it is
     re-judged;
   - LLM checks — make clear the final branch is a model judgement, and what the
     deterministic pre-flight narrows down before the model is asked.
5. **Author / update the two review-flow pages** at `docs/review/standard.html`
   and `docs/review/sca.html`. These document a whole review *mode*, not a single
   check, so read `src/pipeline.js` (and the README's Standard / SCA sections) and
   keep each page in sync with the pipeline:
   - **Standard** (`verify.js <xpi|folder>`) — the single-artifact flow: load →
     `manifest_version`/schema-branch selection → Experiment classification (with
     the outright-reject short-circuit for an unrecognised Experiment when
     `--allow-experiments` is off) → setup/vendor resolution & verification → parse
     & run the deterministic + LLM checks → the `--llm-review` summaries
     (which re-judge escalated "unsure" items) → post-summary
     rechecks → report + manual-review to-do list.
   - **Source Code Archive** (`--sca-root`; `--sca-source` optional) — the split-artifact
     flow: the readable source is the code-defect review target and the subject of the
     behavioral `--llm-review`; the declared dependencies and the build files are
     audited; the built XPI is authoritative for the manifest, experiments,
     file-completeness, `--diff-to` baseline and the packaging summary. In SCA
     `--llm-review` runs two passes — behavioral over the source, packaging over the
     XPI. Show each check routed to its `input` (source / build / XPI) context.

   Follow the check-page template but use a **Review flow** section whose
   `flowchart TD` walks the pipeline stages (not one check's branches), and a
   `source-note` pointing at `src/pipeline.js`. Reuse the shared `classDef` styles
   plus the `step` (process) and `llm` (optional LLM side-step) styles the flow
   pages define — colour every LLM-gated node with `llm`. Show the side-steps in
   full: the LLM pre-flight, vendor LLM resolution, the per-check LLM escalation,
   the summaries and the post-summary recheck; and the complete experiment
   branching (reject-outright vs recognised/modified/accepted → full review with
   namespace registration). Back the diagram with short **Where the LLM is used**
   and **Experiment handling** subsections so nothing is hidden in a collapsed
   node.
6. **Update the sidebar.** Rebuild the `CHECKS` array in `docs/index.html` so it
   lists every check in registry order, grouped by category. Keep the leading
   **Review** category in the `REVIEW_PAGES` array (its two flows, each with an
   explicit `file` under `review/`); `NAV` combines `REVIEW_PAGES` with `CHECKS`.
   If there are multiple categories, add the corresponding `group-title` headings
   and either multiple `<ul class="toc">` lists or category markers — keep it
   consistent with the existing markup.
7. **Keep flowcharts faithful.** The diagram must match what the code does, not
   what the title suggests. When unsure about a branch, read the `run()` body and
   any helper it calls rather than guessing; for the review-flow pages, trace the
   stage order in `runPipeline` / `reviewAddon` rather than the README prose alone.
8. **Verify.** Confirm there is exactly one `docs/checks/<id>.html` per check in
   the registry (no orphans, no missing pages), that the two `docs/review/*.html`
   pages exist and their sidebar entries resolve, that the sidebar count matches,
   and that the Mermaid blocks are syntactically valid. If a headless browser or
   screenshot tool is available, open `docs/index.html` and spot-check a few
   pages render their SVG flowcharts; otherwise validate the HTML/Mermaid by
   inspection.

## Constraints

- No external network requests at view time — Mermaid stays vendored in
  `docs/assets/`.
- Plain English in the prose and node labels; **no code snippets** in the
  flowcharts or descriptions.
- Don't invent severities or behaviour — everything must trace to
  `assets/registry.yaml` and `src/checks/rules/`.
