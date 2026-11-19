# The transport flow (bare sync)

The sync state is just git: the clone's history is the per-machine base, and a conflict is a git merge conflict, per file, against the real merge base. Configs are plain files here; the canonical is never read or written.

## 1. Begin

Run `transport-begin`. It commits a pending change to the declarations file `.git-agents-harnesses.json` on its own, records the pre-sync point after it (kept across retries, so abort always reaches the state the user last confirmed), fetches, mirrors local harness files into the clone, commits them, and merges from origin. Two outcomes:

- `state: "clean"`: `outgoing` lists what this machine contributes, `incoming` what the merge brought. Go to step 3.
- `state: "conflicts"`: `incoming` lists every path the merge touches, and each conflict entry carries `path`, `binary`, the `base`, `local`, and `remote` contents, and `localDeleted` / `remoteDeleted`. Go to step 2.

Excluded paths never travel (see "Excludes" below). Conflicts nobody needs to see are settled before the list is built: a path both sides deleted is deleted, and a conflict on an excluded path drops it from the repo. When that settles every conflict, the outcome is `clean`.

Both outcomes also carry:

- `firstSync[]`: `{harness, name, path, direction, fileCount, totalBytes}`, one entry per path syncing for the first time under a newly declared harness, per direction (`outgoing` or `incoming`) in which it has content. These paths still appear in `outgoing` and `incoming`.
- `removed`, only when another machine removed a declaration: the `harnesses` no longer declared (`{harness, name}`) and the `paths` that stopped syncing (`{harness, name, path, present}`). Those paths are in neither list: they are no longer synced, and the files in this home directory stay.
- `excluded`, only when this run drops excluded paths that the sync repo still held (committed by an earlier git-agents, or before an exclude was added). The deletion leaves the repo only; no home directory loses those files.

If it reports `invalid-harness-declarations`, the local declarations file is invalid and nothing was written: relay every problem and point at `/git-agents harness`.

If it reports `transport-in-progress`, a previous run never finished: inspect with the user and either resolve it or run `transport-abort`.

If it reports `unrelated-histories`, the remote history was rewritten and no longer shares a base with the local clone. Relay the remedy: run `transport-abort` to restore the pre-sync state, re-clone with `setup` and `force:true`, then run the sync again. Local harness files are not affected.

## 2. Resolve conflicts

Git already merged non-overlapping edits silently; what you see genuinely overlaps. Every entry is one path to settle, and each resolution is one of:

- `{"path":"...","content":"..."}`: write these contents.
- `{"path":"...","side":"local"}` (or `"remote"`): take that side as it is. When that side deleted the path (`localDeleted` or `remoteDeleted` is true, and its content is `null`), the pick deletes it.
- `{"path":"...","delete":true}`: delete the path, whichever side kept it.

Per file:

- **Reconcile if compatible.** When both sides can be honored (keep both additions, weave compatible edits), write the reconciliation yourself.
- **Interview if contradictory.** When the sides cannot both be true, show the user both versions and ask which outcome they want (one side, the other, or a wording they give you).
- **Binary files are always a pick-a-side interview**: local or remote, never your call.
- **A deletion against an edit** (`localDeleted` or `remoteDeleted`): one machine removed the file, the other changed it. Interview unless the intent is plain: keep the edit (pick its side) or confirm the deletion (pick the deleting side).
- **An entry with `fileDirectory` is a file/directory conflict**: one side has a file or link at `path` (`fileSide`, `fileKind`; its content is that side's `local` or `remote`, a link's content being its target), the other a directory there (`directorySide`, with `directoryFiles`). Typically a skill folder replaced by a link on one machine. It is always a pick-a-side interview: picking a side restores that side whole under `path`, and `delete` removes both. Git parks the file side under a `path~<label>` name; never handle that name or the files inside the directory yourself, resolve `path`.
- **An entry with `problems` is the declarations file**: git merged it cleanly, but the result is invalid, and `transport-commit` refuses until it is fixed. Relay every problem, then draft corrected full contents starting from `merged` (with `base`, `local`, and `remote` for reference), following the shape and path rules of [harness-flow.md](harness-flow.md); interview when the sides contradict. The fix is the whole file, submitted as `content`.

Submit resolutions with `transport-resolve`, as many as you like in one batch: `{"files":[{"path":"...","content":"..."},{"path":"...","side":"remote"},{"path":"...","delete":true}]}`. The whole batch is checked before any of it is applied: a path that is not a conflict (`not-conflicted`), a path given twice (`invalid-input`), or contents for a file/directory conflict (`invalid-resolution`) refuses the batch, and nothing is resolved; fix the entry and resubmit the batch. `remaining` lists what is still unresolved. Every resolution goes through `transport-resolve`: never run git in the clone yourself. Instruction files carrying `ga:` markers are plain text here; do not consult the canonical. The declarations file is validated on the way in, whether you submit contents or a side: invalid input is refused with `invalid-harness-declarations`, nothing is written, and you fix it and resubmit.

## 3. Gate, then commit

Show the user what will change: the incoming and outgoing paths; the `excluded` paths leaving the repo, stating that the files stay in every home directory; each `firstSync` path with its harness's name, direction, file count, and total size; each harness and path in `removed`, stating that the local files stay in the home directory, unsynced; and for every conflicted file a diff of the resolution against both sides. Ask for confirmation per the gate rule (SKILL.md, "The gate"). Declining means `transport-abort`, which restores the recorded pre-sync state even when the merge completed cleanly on its own. Declining never undoes a declaration: one made on this machine was committed before the pre-sync point, and one pulled from another machine arrives again on the next sync; the way out is to remove it with `/git-agents harness`. On yes, run `transport-commit`. It completes the merge, pushes, then mirrors the merged result back into the home directory, so a failed push never touches local files. On `push-failed`, re-running `transport-commit` retries the push safely; on `push-rejected`, origin advanced mid-transport: run `transport-begin` again to merge the new changes first.

## 4. Report

Close with what traveled in each direction and how each conflict was settled. If `status` now shows stale generated files, or an `untracked` one (a newly declared instructions file before its first convergence), mention `/git-agents sync unify`.

## Excludes

Some files inside synced paths belong to one machine, and are never synced in either direction. They are never copied into the repo, never written to a home directory, and never overwritten or deleted there. When a synced folder is replaced or removed, the excluded entries inside it stay, and a folder holding only excluded entries counts as absent. The built-in list:

- `.claude/skills/synced`: Claude Code's claude.ai skill sync (manifest, staging, the synced copies).
- Any `.trash` or `.staging` folder, such as Claude Code's `.claude/skills/.trash`.
- `.codex/skills/.system`: Codex's bundled system skills.
- Any `node_modules`, `__pycache__`, or `.venv` folder: what a skill installs or builds for one machine.
- Any `.git` folder: a skill cloned with git syncs its files, not its repository.
- `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`: operating-system files.
- git-agents' own temporary `.<name>.git-agents-incoming-*` and `.<name>.git-agents-backup-*` names.

Users add their own excludes in `.git-agents-excludes` at the root of the sync repo clone (`~/.git-agents/`): one pattern per line, `#` for comments. A pattern without a `/` matches that name at any depth (`notes`, `*.log`). A pattern with a `/` matches from the home directory (`.claude/skills/local-only`). `*` and `?` match within a name, `**` any number of folders, and matching ignores case. The file is committed with the next sync and applies on every machine. It is the one file in the clone you may edit, and only on the user's request. When the user asks to stop syncing something inside a synced folder, propose the pattern and add it on a yes. Then run the sync, whose gate lists what it drops from the repo under `excluded`. To stop syncing a whole path, change the harness declarations instead (`/git-agents harness`).

`status` reports file counts and hashes without excluded entries.
