# The unify flow (sync unify)

One unified convergence run: transport, then canonical merge, then regeneration, then a single push at the end. The first run is not special: it is simply the flow facing its biggest drift (no canonical yet, every file fully unattributed).

Every write goes through the gate (exact diffs and a plain-text question in the same message, explicit confirmation, no question tools, No default).

## 1. Transport, push deferred

Run the transport flow ([transport-flow.md](transport-flow.md)) with one change: call `transport-commit` with `{"deferPush":true}`. Other machines' files and canonical arrive; this machine's files are committed; nothing is pushed yet.

## 2. Gather

Run `gather`. The result holds:

- `canonicalVersion`, `core`, `overlays`: the current canonical content (all null/empty on first run).
- `files[]`: per harness, the parse state (`parsed`, `absent`, `mangled`) and `regions[]` attributing content to `core`, `overlay`, or `unattributed`, each with a `changed` flag and both sides of the comparison.
- `inputs`: the freshness token; pass it to stage untouched.

## 3. Draft the merge

Propose the full result in one pass: a single `core` plus per-harness `overlays`. Classification rules:

- Content that helps every harness goes to the core.
- Content that only makes sense for one harness (its model names, its own tool quirks) goes to that harness's overlay.
- Harness-appended memory (unattributed regions) is real input: classify it like anything else.
- Obvious duplicates collapse; near-duplicates merge into the clearest phrasing.

Ask the user **only** about genuinely ambiguous chunks: content you cannot confidently place in core, an overlay, or the bin. On a steady-state run that is usually zero questions; on a first run, a handful. Batch the questions; never walk the user through every line.

## 4. Stage

Run `stage` with `{"core":"...","overlays":{...},"inputs":<gather.inputs>}`. Write that JSON to a temp file and pass it with `--input-file` (or pipe it via `--input -`): the payload carries multi-line content with backslashes and backticks, which inline `--input` can corrupt through shell quoting, especially on Windows.

- Show every non-empty `diff` from the result verbatim (they cover canonical core, overlays including deletions, and all four generated files).
- Surface every warning: `near-cap` or `over-cap` means the Codex file approaches or exceeds its 32 KiB silent-truncation cap; propose trimming before applying.
- On `stale-inputs`: something changed since gather; go back to step 2.

## 5. Gate, then apply

Confirm with the user against the staged diffs, plain text in the same message as the diffs (gate rule). On yes, run `apply`. On `stale-inputs`, go back to step 2. On success the canonical is written, all copies regenerate, and the stage clears.

## 6. The single push

Run `transport-begin` once more (it commits the regenerated copies and the canonical; with no remote activity in between it reports clean), then `transport-commit` without deferring. Everything from transport and convergence leaves in one push. If this begin reports conflicts instead (origin advanced while you were converging), run the transport conflict steps ([transport-flow.md](transport-flow.md)) before committing; if the merge brought canonical changes, re-run gather afterward to confirm nothing new drifted.

## 7. Report

Close with the canonical version, which files converged, how conflicts were settled, and any caveats still standing from `status`.
