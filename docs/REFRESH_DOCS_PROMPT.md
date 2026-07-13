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
- `docs/index.html` — the shell. A left sidebar lists the orientation pages
  (`GUIDE_PAGES`) then every check (grouped by category), and the right pane is
  an `<iframe>` that loads the selected page. The check list is a hand-authored
  `CHECKS` array in an inline `<script>`, combined with `GUIDE_PAGES` into `NAV`.
  Each nav entry may carry an explicit `file` (relative to `docs/`); checks
  default to `checks/<id>.html`. Selection uses `location.hash` for linkable
  pages, and the default landing page is the review-pipeline flow
  (`check-flow.html`).
- `docs/assets/style.css` — shared styling for the shell and the check pages.
- `docs/assets/mermaid.min.js` — Mermaid, **vendored locally** (offline). Do not
  switch to a CDN.
- `docs/checks/<id>.html` — one standalone page per check.
- `docs/check-flow.html` — the review-pipeline page (`GUIDE_PAGES`): documents
  the whole review flow across both modes; its flowchart walks the pipeline
  stages, not one check's branches.

## Sources of truth (read these to (re)generate content)

1. `assets/registry.yaml` — the canonical list of checks, in order, with each
   check's `title`, `severity` (`error` / `warning` / `info`), `check` (the
   kebab-case id), `response` (developer-facing message), and often a leading
   comment block describing intent. Some entries have no `severity` (manual /
   producer checks) or special fields (`diff`, `summary-prompt`,
   `permission-recheck`). The check-bearing sections ARE the phases — a check's phase
   IS the section it lives in, never a field on the entry: `invalid-experiment-phase`
   (the only phase that runs for an invalid Experiment), `deterministic-phase`,
   `llm-phase`, and `post-summary-phase` — the last holds every recheck CONSUMER (the
   target of a producer's `post-summary-recheck:`), which is re-judged by the
   `--llm-review` summary and declares no `input`. `manual-checks` is NOT a phase: it
   is the static by-hand to-do list, never run as checks.
2. `src/checks/rules/<id>.js` — the implementation of each check. The header
   comment block describes the decision logic in prose; the `run()` body is the
   ground truth for the branches. Shared logic lives in `src/lib/`
   (e.g. `permissions.js`, `reachability.js`) — read those when a rule delegates
   to them.
3. `README.md` — overall framing (deterministic vs LLM vs manual checks, the
   `--llm-review` recheck mechanism, producer/consumer pairs), and the
   **Standard** vs **Source code archive (SCA)** review modes.
4. `src/pipeline.js` — the review pipeline (`runPipeline`): the ground truth for
   the review-pipeline page (`check-flow.html`). It shows the stage order
   (load → resolve schema → experiment classification → vendor/library/build setup →
   parse → build the run context → run checks → summaries → recheck → report) and the
   `mode === "sca"` forks (the source /
   dependency / build / shipped-XPI / shipped-manifest split, routed via `routeCtx`
   through `buildShippedCtx` / `buildScaBuildCtx` / `buildManifestCtx`).

## Steps

1. **Enumerate checks.** Parse `assets/registry.yaml` to get the full ordered
   list of checks and their metadata. Cover ALL check-bearing sections (= the phases) -
   `invalid-experiment-phase`, `deterministic-phase`, `llm-phase`, and
   `post-summary-phase` - plus the static `manual-checks` list (do not miss the recheck
   consumers in `post-summary-phase`) - noting the section each lives under (that IS its
   phase, and the sidebar group) and any check with no severity (manual-review /
   escalation producers).
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
5. **Update the sidebar.** Rebuild the `CHECKS` array in `docs/index.html` so it
   lists every check in registry order, grouped by category; `NAV` combines
   `GUIDE_PAGES` with `CHECKS`. If there are multiple categories, add the
   corresponding `group-title` headings and either multiple `<ul class="toc">`
   lists or category markers — keep it consistent with the existing markup.
6. **Keep flowcharts faithful.** The diagram must match what the code does, not
   what the title suggests. When unsure about a branch, read the `run()` body and
   any helper it calls rather than guessing.
7. **Verify.** Confirm there is exactly one `docs/checks/<id>.html` per check in
   the registry (no orphans, no missing pages), that every sidebar entry
   resolves, that the sidebar count matches, and that the Mermaid blocks are
   syntactically valid. If a headless browser or screenshot tool is available,
   open `docs/index.html` and spot-check a few
   pages render their SVG flowcharts; otherwise validate the HTML/Mermaid by
   inspection.

## Constraints

- No external network requests at view time — Mermaid stays vendored in
  `docs/assets/`.
- Plain English in the prose and node labels; **no code snippets** in the
  flowcharts or descriptions.
- Don't invent severities or behaviour — everything must trace to
  `assets/registry.yaml` and `src/checks/rules/`.
