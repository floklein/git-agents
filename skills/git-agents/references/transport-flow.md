# The transport flow (bare sync)

The sync state is just git: the clone's history is the per-machine base, and a conflict is a git merge conflict, per file, against the real merge base. Configs are plain files here; the canonical is never read or written.

## 1. Begin

Run `transport-begin`. It commits a pending change to the declarations file `.git-agents-harnesses.json` on its own, records the pre-sync point after it (kept across retries, so abort always reaches the state the user last confirmed), fetches, mirrors local harness files into the clone, commits them, and merges from origin. Two outcomes:

- `state: "clean"`: `outgoing` lists what this machine contributes, `incoming` what the merge brought. Go to step 3.
- `state: "conflicts"`: `incoming` lists every path the merge touches, and each conflict entry carries `path`, `binary`, and the `base`, `local`, and `remote` contents. Go to step 2.

Both outcomes also carry:

- `firstSync[]`: `{harness, name, path, direction, fileCount, totalBytes}`, one entry per path syncing for the first time under a newly declared harness, per direction (`outgoing` or `incoming`) in which it has content. These paths still appear in `outgoing` and `incoming`.
- `removed`, only when another machine removed a declaration: the `harnesses` no longer declared (`{harness, name}`) and the `paths` that stopped syncing (`{harness, name, path, present}`). Those paths are in neither list: they are no longer synced, and the files in this home directory stay.

If it reports `invalid-harness-declarations`, the local declarations file is invalid and nothing was written: relay every problem and point at `/git-agents harness`.

If it reports `transport-in-progress`, a previous run never finished: inspect with the user and either resolve it or run `transport-abort`.

If it reports `unrelated-histories`, the remote history was rewritten and no longer shares a base with the local clone. Relay the remedy: run `transport-abort` to restore the pre-sync state, re-clone with `setup` and `force:true`, then run the sync again. Local harness files are not affected.

## 2. Resolve conflicts

Git already merged non-overlapping edits silently; what you see genuinely overlaps. Per file:

- **Reconcile if compatible.** When both sides can be honored (keep both additions, weave compatible edits), write the reconciliation yourself.
- **Interview if contradictory.** When the sides cannot both be true, show the user both versions and ask which outcome they want (one side, the other, or a wording they give you).
- **Binary files are always a pick-a-side interview**: local or remote, never your call.
- **An entry with `problems` is the declarations file**: git merged it cleanly, but the result is invalid, and `transport-commit` refuses until it is fixed. Relay every problem, then draft corrected full contents starting from `merged` (with `base`, `local`, and `remote` for reference), following the shape and path rules of [harness-flow.md](harness-flow.md); interview when the sides contradict. The fix is the whole file, submitted as `content`.

Submit text resolutions with `transport-resolve` (`{"files":[{"path":"...","content":"..."}]}`); submit side picks with `{"files":[{"path":"...","side":"local"}]}` (or `"remote"`). Instruction files carrying `ga:` markers are plain text here; do not consult the canonical. The declarations file is validated on the way in, whether you submit contents or a side: invalid input is refused with `invalid-harness-declarations`, nothing is written, and you fix it and resubmit.

## 3. Gate, then commit

Show the user what will change: the incoming and outgoing paths; each `firstSync` path with its harness's name, direction, file count, and total size; each harness and path in `removed`, stating that the local files stay in the home directory, unsynced; and for every conflicted file a diff of the resolution against both sides. Ask for confirmation per the gate rule (SKILL.md, "The gate"). Declining means `transport-abort`, which restores the recorded pre-sync state even when the merge completed cleanly on its own. Declining never undoes a declaration: one made on this machine was committed before the pre-sync point, and one pulled from another machine arrives again on the next sync; the way out is to remove it with `/git-agents harness`. On yes, run `transport-commit`. It completes the merge, pushes, then mirrors the merged result back into the home directory, so a failed push never touches local files. On `push-failed`, re-running `transport-commit` retries the push safely; on `push-rejected`, origin advanced mid-transport: run `transport-begin` again to merge the new changes first.

## 4. Report

Close with what traveled in each direction and how each conflict was settled. If `status` now shows stale generated files, or an `untracked` one (a newly declared instructions file before its first convergence), mention `/git-agents sync unify`.
