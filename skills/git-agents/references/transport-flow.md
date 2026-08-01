# The transport flow (bare sync)

The sync state is just git: the clone's history is the per-machine base, and a conflict is a git merge conflict, per file, against the real merge base. Configs are plain files here; the canonical is never read or written.

## 1. Begin

Run `transport-begin`. It records the pre-sync point (kept across retries, so abort always reaches the state the user last confirmed), mirrors local harness files into the clone, commits them, and merges from origin. Two outcomes:

- `state: "clean"`: `outgoing` lists what this machine contributes, `incoming` what the merge brought. Go to step 3.
- `state: "conflicts"`: `incoming` lists every path the merge touches, and each conflict entry carries `path`, `binary`, and the `base`, `local`, and `remote` contents. Go to step 2.

If it reports `transport-in-progress`, a previous run never finished: inspect with the user and either resolve it or run `transport-abort`.

If it reports `unrelated-histories`, the remote history was rewritten and no longer shares a base with the local clone. Relay the remedy: run `transport-abort` to restore the pre-sync state, re-clone with `setup` and `force:true`, then run the sync again. Local harness files are not affected.

## 2. Resolve conflicts

Git already merged non-overlapping edits silently; what you see genuinely overlaps. Per file:

- **Reconcile if compatible.** When both sides can be honored (keep both additions, weave compatible edits), write the reconciliation yourself.
- **Interview if contradictory.** When the sides cannot both be true, show the user both versions and ask which outcome they want (one side, the other, or a wording they give you).
- **Binary files are always a pick-a-side interview**: local or remote, never your call.

Submit text resolutions with `transport-resolve` (`{"files":[{"path":"...","content":"..."}]}`); submit side picks with `{"files":[{"path":"...","side":"local"}]}` (or `"remote"`). Instruction files carrying `ga:` markers are plain text here; do not consult the canonical.

## 3. Gate, then commit

Show the user what will change: the incoming and outgoing paths, and for every conflicted file a diff of the resolution against both sides. Ask for confirmation per the gate rule (SKILL.md, "The gate"). Declining means `transport-abort`, which restores the recorded pre-sync state even when the merge completed cleanly on its own. On yes, run `transport-commit`. It completes the merge, pushes, then mirrors the merged result back into the home directory, so a failed push never touches local files. On `push-failed`, re-running `transport-commit` retries the push safely; on `push-rejected`, origin advanced mid-transport: run `transport-begin` again to merge the new changes first.

## 4. Report

Close with what traveled in each direction and how each conflict was settled. If `status` now shows stale generated files, mention `/git-agents sync unify`.
