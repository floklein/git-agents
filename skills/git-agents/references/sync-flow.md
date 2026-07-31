# The sync workflow

One unified flow. The first run is not special: it is simply the biggest drift (no canonical yet, every file fully unattributed).

Run the steps in order. Every write goes through the gate (exact diffs, explicit confirmation, No default).

## 1. Pull

Run the pull subcommand as documented in SKILL.md (preview, gate, execute). This brings other machines' canonical and files into the clone before merging.

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

Run `stage` with `{"core":"...","overlays":{...},"inputs":<gather.inputs>}`.

- Show every non-empty `diff` from the result verbatim (they cover canonical core, overlays including deletions, and all four generated files).
- Surface every warning: `near-cap` or `over-cap` means the Codex file approaches or exceeds its 32 KiB silent-truncation cap; propose trimming before applying.
- On `stale-inputs`: something changed since gather; go back to step 2.

## 5. Gate, then apply

Confirm with the user against the staged diffs. On yes, run `apply`. On `stale-inputs`, go back to step 2. On success the canonical is written, all copies regenerate, and the stage clears.

## 6. Push

Run the push subcommand (preview, gate, execute) so the new canonical and files reach the remote.

## 7. Report

Close with the canonical version, which files converged, and any caveats still standing from `status`.
