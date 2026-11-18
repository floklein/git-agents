# The harness flow (harness)

Custom harness declarations live in `.git-agents-harnesses.json` at the root of the sync repo. The file is committed and reaches every machine through an ordinary sync; once a harness is declared, every machine transports its paths and generates its instructions file, as for a built-in. You write the file only through `harness-stage` and `harness-apply`: never edit it by hand, not even to fix one character. (The user may; the next sync validates a hand edit the same way.)

Every write goes through the gate rule (SKILL.md, "The gate").

## 1. Read the current set

Run `status`. Its `harnesses[]` lists the built-ins (`claude-code`, `codex`, `cursor`, `gemini-cli`, `opencode`) first, then the custom harnesses sorted by id, each as `{id, name, instructionsFile?, syncPaths}`. Its `syncPaths` reports every path the harness transports, the instructions file first; a declaration does not repeat the instructions file in `syncPaths`.

If `caveats` holds `invalid-harness-declarations`, the file is invalid: `status` reports the built-ins alone, every sync is blocked, and the caveat lists each problem. The proposal you stage replaces the whole file, so this flow is the repair route. Read the file at the caveat's `path` to recover what was meant, and redraft it.

With no request text, list the built-in and custom harnesses (name, id, instructions file, synced paths) and ask what to change; the answer is the request.

## 2. Draft the complete set

`harness-stage` takes the complete proposed set of custom harnesses, `{"harnesses": {"<id>": {...}}}`, never a delta: every declaration that stays, with the change folded in. A declaration left out is removed; `{"harnesses": {}}` removes them all. The script writes `version`. The built-ins never appear in the set.

Each declaration has these fields, and no others:

- `name` (optional): the display name, defaulting to the id.
- `instructionsFile` (optional): the harness's global instructions file. `sync unify` generates it from the canonical and merges edits back. It transports on its own and is not repeated in `syncPaths`.
- `syncPaths` (optional): files or directories that only transport.
- At least one of `instructionsFile` and `syncPaths`.

Ids are lowercase letters, digits, and hyphens, start with a letter, and run at most 32 characters. An id is not a Windows device name (`con`, `nul`, `com1`, and so on) and not a built-in id in either scheme (`claude-code`, `claude`, `codex`, `cursor`, `gemini-cli`, `gemini`, `opencode`). Ids are immutable: a new id is a removal plus a fresh declaration, and the overlay goes with the old id. To rename a harness for display, change its `name`.

Paths are home-relative and the same string on every OS: forward slashes, no `~`, no environment variables, no `..`, no empty or `.` segments, every segment valid on Windows. Each path is at least two segments deep (`.dsh/skills`, never `.dsh`), does not start with `.git`, `.git-agents`, or `canonical`, and is not, or inside, a credential directory (`.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.config/gh`, `.config/gcloud`, `.config/git`). A path has one owner: it is declared once and never nested inside another, built-in paths included, compared case-insensitively. So a harness that also reads a file a built-in already generates is declared without that file, and a harness whose location differs by OS gets one declaration per location.

Ask only when the request is genuinely ambiguous, such as a path you cannot infer; otherwise decide, and let the gate speak.

## 3. Stage

Write the proposal to a temp file and run `harness-stage` with `--input-file`. The result holds:

- `file`: `path`, `changed`, and `diff`, the exact unified diff of the declarations file. When `changed` is false, nothing would change: say so and stop.
- `startSyncing[]`: `{harness, field, path, present, fileCount, totalBytes}`, each path that starts syncing and what this home directory holds there (`field` is `instructionsFile` or `syncPaths`).
- `stopSyncing[]`: `{harness, field, path}`, each path that stops syncing. A changed `name`, or a path that moves to another harness or field, appears in neither list.
- `removal`, only when the proposal removes a harness or a path: the removed `harnesses` (`{harness, name}`), the `repoFiles` deleted from the sync repo, the `overlays` deleted with their `content`, the `manifest` entries deleted, `canonicalVersionChanges`, and `homeFiles`, the statement that home files stay.
- `currentProblems`: what makes the current file invalid, when it is.

On `invalid-harness-proposal`, nothing is written: relay every problem the message lists, redraft, and stage again. On `harness-file-not-regular`, a link or directory sits where the file belongs: relay the message and stop.

## 4. Gate, then apply

In one message, show:

- the `file.diff`, verbatim;
- each path that starts syncing, with its harness's name, its file count, and its total size (or that nothing is there yet when `present` is false);
- each path that stops syncing;
- for a removal, every repo file being deleted, every overlay being deleted with its content verbatim, and the `homeFiles` statement; when `canonicalVersionChanges` is true, add that the remaining generated files read as stale until the next `sync unify`;
- when `currentProblems` is not empty, the problems the new file repairs.

Then ask, per the gate rule. On yes, run `harness-apply` (no input). It returns `{path, written}`, plus `removed` with what it deleted from the clone. On `stale-harness-stage`, the file changed since staging: go back to step 1. On `no-harness-stage` or `invalid-harness-stage`, stage again.

Nothing is committed yet: the next `transport-begin` commits the declarations file and the cleanup together, before the point a declined sync returns to, so declining that sync never undoes the declaration.

## 5. Offer the sync

Never chain automatically. Offer `/git-agents sync unify` when an instructions file was declared (a `startSyncing` entry with `field: "instructionsFile"`) or when `removal.canonicalVersionChanges` was true; otherwise offer `/git-agents sync`. Run it only on an explicit yes. Other machines receive the change on their next sync.
