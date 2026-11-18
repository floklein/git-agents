# ga sync: cross-harness instruction sync (spec)

Build-ready spec assembled from wayfinder map [floklein/git-agents#4](https://github.com/floklein/git-agents/issues/4), amended for the reshaped subcommand surface from map [floklein/git-agents#25](https://github.com/floklein/git-agents/issues/25), extended with the `edit` subcommand from [#45](https://github.com/floklein/git-agents/issues/45), and extended with custom harnesses from map [floklein/git-agents#48](https://github.com/floklein/git-agents/issues/48). Each section links the decision ticket that holds its rationale.

## Overview

git-agents pivots to **skill-first, for the whole product** ([#7](https://github.com/floklein/git-agents/issues/7)). The product becomes an Agent Skill (a `SKILL.md` plus deterministic scripts) installed into all five supported harnesses: Claude Code, Codex, Cursor, Gemini CLI, OpenCode.

The user surface is six items ([#28](https://github.com/floklein/git-agents/issues/28), extended by [#45](https://github.com/floklein/git-agents/issues/45) and [#53](https://github.com/floklein/git-agents/issues/53)):

- `/git-agents sync`: **transport**. Configs are treated independently and copied to and from the repo, git-native, with agent-resolved conflicts. The canonical is never involved.
- `/git-agents sync unify`: **convergence**. Transport first, then the per-harness global instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, ...) merge into one canonical version and every copy regenerates.
- `/git-agents edit <request>`: **freeform canonical edit**. The convergence flow with one extra drafting input: the agent interprets the request (add, reword, remove) and folds it into the proposed canonical alongside any drift.
- `/git-agents harness <request>`: **custom harness authoring**. The agent interprets the request (add, change, remove) and drafts the declarations file; see [Custom harnesses](#custom-harnesses-48).
- `/git-agents status`: read-only report.
- `/git-agents setup`: one-time onboarding.

Standing constraints (map Notes):

- Windows stays first-class.
- Machine sync keeps its behavior and data model; only its front end moves into the skill.
- All five harnesses covered from day one (Cursor with a documented limitation, see below). These five are the **built-in harnesses**.
- A user can declare **custom harnesses** beyond the five. A declared custom harness is treated exactly like a built-in in every flow, with no second-class behavior ([#50](https://github.com/floklein/git-agents/issues/50)). A user who declares none sees no change at all.
- A harness is assumed present; all sync logic lives in deterministic scripts that are **internal to the skill**, not a user-facing surface. The model only orchestrates, resolves conflicts, and performs semantic merges; file operations burn no tokens. No agent means no sync ([#9](https://github.com/floklein/git-agents/issues/9)).
- **Bare `sync` never touches the canonical** ([#26](https://github.com/floklein/git-agents/issues/26)).

## Goals

1. One canonical global-instructions document, shared across harnesses and machines.
2. Bidirectional: edits made in any harness file (by the user or by the harness itself, e.g. Claude Code `#` memory) merge back into the canonical.
3. Deterministic, reviewable writes: nothing changes on disk without an exact diff and explicit confirmation.

## Non-goals

- Config-field sync across harness settings schemas ([#11](https://github.com/floklein/git-agents/issues/11)): ruled out of scope; future effort with its own map.
- Thread/session sync: parked as fog on the map for a future effort.
- Project-level instruction files (repo `AGENTS.md` etc.): this spec covers **global** (home-directory) files only.
- Reworking machine-sync semantics.
- Altering a built-in harness through a declaration (adding a sync path to one, disabling one), or moving the built-in definitions out of the code into the declarations file: a separate effort. Built-in ids are reserved in the declarations file, which keeps an override-by-id open for it.
- For custom harnesses: paths outside the home directory, per-OS path variants, environment variables that relocate a harness, harness-specific caveat detection (size caps, shadow files), pointer-style harnesses with no instructions file, instruction files that are not plain Markdown, and installing the git-agents skill into a custom harness so it can host a sync.

## Architecture ([#7](https://github.com/floklein/git-agents/issues/7), [#13](https://github.com/floklein/git-agents/issues/13))

Three layers:

1. **SKILL.md** (`name`, `description`, `disable-model-invocation`), placed at `~/.claude/skills/git-agents/` and `~/.agents/skills/git-agents/` so all five harnesses discover it. It instructs the agent how to drive a sync conversation and which script commands to call.
2. **Deterministic scripts**, delivered by the npm package and invoked by the agent through an internal command surface (see below). They do all file I/O, git operations, diffing, and manifest bookkeeping. They never make semantic decisions.
3. **The agent** (whichever harness is hosting) orchestrates: runs scripts, performs the semantic merge, asks the user targeted questions, and requests confirmation before apply.

### Script command surface (internal)

Hidden subcommands of the npm binary, JSON in/out, no interactive prompts. Not documented for end users; the SKILL.md is their only caller. Minimum set:

| Command | Effect |
| --- | --- |
| `status` | Report config presence, every harness (built-in and custom) in the declaration shape with its paths and hashes, canonical version, drift summary, caveats. Never fails on an invalid declarations file; reports it as a caveat |
| `transport-begin` | Commit a pending declarations change ahead of the pre-sync point, record the pre-sync point (kept across retries), fetch and read the remote's declarations file, mirror local harness files into the clone, commit them (scoped), attempt the merge from origin; report either the clean incoming/outgoing changes or the remote side's touched paths plus the conflicted files with base, local, and remote contents |
| `transport-resolve` | Accept per-file resolutions: full contents for text, or a local/remote side pick (binary conflicts). Validates the declarations file whenever it is the resolved path |
| `transport-commit` | Complete the merge commit, push, then mirror the merged result back to the home directory (a rejected push leaves home untouched); refuses without a transport in progress or while conflicts remain unresolved; distinguishes retryable push failures from origin-advanced rejection. Takes a defer-push option used by `sync unify` |
| `transport-abort` | Abort the in-progress merge and restore the recorded pre-sync state, including after a clean auto-merge |
| `gather` | Collect the harness files and canonical into a merge workspace; emit structured diffs vs canonical |
| `stage` | Accept a proposed canonical (core + overlays) from the agent; render exact per-file diffs of what apply would write |
| `apply` | Write staged results to canonical and harness files; update manifest; refuse if inputs changed since stage |
| `propagate` | Regenerate harness copies from the current canonical |
| `install-pointer-docs` | Print the Cursor pointer-rule text for the user to paste (see Cursor) |
| `harness-stage` | Accept the complete proposed set of custom harness declarations; validate it; render the exact diff of the declarations file plus the paths that start or stop syncing |
| `harness-apply` | Write the staged declarations file in the clone, with the repo-side consequences of any removal; refuse if the file changed since staging |

All commands are idempotent and safe to re-run where the underlying git state allows; `transport-commit`, `apply`, and `propagate` are the only ones that write outside the workspace and the clone (`harness-apply` writes inside the clone only). The former one-directional `pull` and `push` commands are superseded by the transport primitives ([#26](https://github.com/floklein/git-agents/issues/26)).

## Canonical model ([#8](https://github.com/floklein/git-agents/issues/8))

- **Core + per-harness overlays.** One canonical core document holds shared content; each harness may have an overlay for harness-specific instructions. Identical-everywhere is the empty-overlay case.
- **Propagation is copy**, never symlink (Windows privileges, Gemini ignoring symlinked `GEMINI.md`, Cursor/OpenCode symlink bugs, `core.symlinks=false` in Git for Windows).
- **Bidirectional**: drift in any harness file is semantically merged back into core or the right overlay, then all copies regenerate.

### Storage ([#10](https://github.com/floklein/git-agents/issues/10))

Canonical content lives in the sync repo's working tree and is committed to the remote:

```
~/.git-agents/
  canonical/
    core.md
    overlays/
      claude.md      (optional, one per harness)
      codex.md
      gemini.md
      opencode.md
      cursor.md      (used only by the pointer rule)
      <id>.md        (optional, one per custom harness, named by its id)
```

Cross-machine transport is therefore inherent to machine sync. No standing copy elsewhere in the home directory.

The **canonical version** hashes the core plus the overlays of every harness: the built-ins in their existing order, then the custom harnesses sorted by id ([#51](https://github.com/floklein/git-agents/issues/51)). The order is the same on every machine, and with no custom harness declared the version is identical to what it was before custom harnesses existed ([#56](https://github.com/floklein/git-agents/issues/56)).

### Generated file format (overlay delimiting)

Each generated harness file is assembled as core, then overlay, wrapped in HTML comment markers that carry the canonical version:

```markdown
<!-- ga:begin core v=<canonical-version> -->
...core content...
<!-- ga:end core -->
<!-- ga:begin overlay harness=claude v=<canonical-version> -->
...overlay content...
<!-- ga:end overlay -->
```

Attribution rules for merge-back:

- An edit inside the core block is a proposed core change.
- An edit inside the overlay block is a proposed overlay change.
- Content outside any block (typical for harness-appended memory, which lands at end of file) is new content the agent classifies during merge (core, overlay, or drop).
- Missing or mangled markers degrade gracefully: the whole file is treated as unattributed content and re-classified.

HTML comments are inert instruction content for every harness; the size cost is counted against the Codex cap (below).

A custom harness's instructions file uses this format unchanged, with its id in the overlay marker (`harness=<id>`). The marker pattern accepts the custom id character set (lowercase letters, digits, hyphens) as well as the built-in overlay ids ([#51](https://github.com/floklein/git-agents/issues/51)). One consequence: a generated file begins with the core marker, so a harness that needs front matter at the top of its file cannot be supported.

### Target files

| Harness | Generated file |
| --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| Gemini CLI | `~/.gemini/GEMINI.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| Cursor | none (see below) |
| A custom harness | its declared `instructionsFile`, or none when the declaration has only `syncPaths` |

### Cursor ([#8](https://github.com/floklein/git-agents/issues/8))

Cursor has no global instructions file (verified; open feature request). Cursor is **excluded from automatic propagation**, as a documented limitation. Opt-in workaround, documented and printed by `install-pointer-docs`: a one-time manual User Rule in Cursor's settings that instructs the agent to read `~/.git-agents/canonical/core.md` (plus `overlays/cursor.md` if present) at session start. Revisit when Cursor ships global AGENTS.md support. The undocumented no-op `~/.cursor/rules` path is **dropped from the sync path list**.

## Custom harnesses ([#48](https://github.com/floklein/git-agents/issues/48))

A **custom harness** is one the user adds beyond the five built-ins. Its entry is a **declaration**, and adding one is **declaring** a custom harness. Once declared, a custom harness is treated exactly like a built-in in every flow: every machine sharing the repo transports its paths and regenerates its instructions file, whether or not the harness is installed there, as happens for the five ([#50](https://github.com/floklein/git-agents/issues/50)).

### Where declarations live ([#50](https://github.com/floklein/git-agents/issues/50))

- Declarations live in a dedicated file at the root of the sync repo, **`.git-agents-harnesses.json`**, which is part of the commit scope. It is the single source of truth and reaches every machine through an ordinary sync.
- Nothing about harnesses goes in `~/.git-agents/config.json`. There is no machine-local path override and no per-machine opt-in.
- It is not a section of the manifest: declarations are authored, while `.git-agents-sync.json` is script bookkeeping that is rewritten whole.
- **An absent file means exactly the behavior without custom harnesses.** The scripts never create the file before the first declaration, and an empty `harnesses` object is treated the same as an absent file.

### The declaration shape ([#51](https://github.com/floklein/git-agents/issues/51))

The file is an object keyed by harness id, with a top-level `version`:

```json
{
  "version": 1,
  "harnesses": {
    "dsh": {
      "name": "DeepSeek Harness",
      "instructionsFile": ".dsh/AGENTS.md",
      "syncPaths": [".dsh/skills"]
    }
  }
}
```

- `instructionsFile` (optional): one path, the harness's global instructions file. Convergence generates it and merges it back. It transports implicitly and is not repeated in `syncPaths`. Any filename is allowed, with no extension requirement.
- `syncPaths` (optional): files or directories that only transport, with the same semantics as a built-in's sync paths.
- `name` (optional): display name, defaulting to the id.
- At least one of `instructionsFile` and `syncPaths` is required.
- Unknown fields and an unsupported `version` make the file invalid; they are not ignored. `version` is the route for future fields.

**Ids.** A custom harness has one id, used everywhere: reports, the overlay file `canonical/overlays/<id>.md`, the `harness=<id>` marker, and the manifest keys.

- Lowercase letters, digits and hyphens, starting with a letter, at most 32 characters (`^[a-z][a-z0-9-]{0,31}$`).
- Not a Windows device name (`con`, `prn`, `aux`, `nul`, `com1` to `com9`, `lpt1` to `lpt9`), because the id becomes a filename.
- Not equal to any built-in id in either scheme: `claude-code`, `claude`, `codex`, `cursor`, `gemini-cli`, `gemini`, `opencode`. The built-ins keep their two ids (one for transport reports, one for overlays, markers and manifest keys) untouched.
- Ids are immutable: changing one is a removal plus a fresh declaration ([#57](https://github.com/floklein/git-agents/issues/57)).

**Order.** Custom harnesses are processed after the built-ins, sorted by id.

**Paths are literal.** Every path is one home-relative string, the same on every OS: no per-OS variants, no environment variable expansion, no `~`. A harness whose location differs by OS (Goose and Devin CLI read from `AppData\Roaming` on Windows) needs one declaration per location; under the parity rule each is written on every machine, so one of them is an unread file.

### Path rules ([#52](https://github.com/floklein/git-agents/issues/52))

Every declared path, whether `instructionsFile` or an entry in `syncPaths`, must pass all of these. A violation makes the file invalid.

1. **Portable.** Relative, forward slashes only, no `..`, no empty or `.` segments. Every segment is valid on Windows as well: none of `< > : " | ? *`, no trailing dot or space, no device names.
2. **Never at the home root.** At least two segments deep. This refuses a whole top-level directory (`.dsh`, `.config`) and top-level files (`.bashrc`).
3. **Reserved names.** Refused when the first segment is `.git`, `.git-agents` or `canonical`.
4. **Credential denylist.** Refused when the path is, or is inside, one of `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.config/gh`, `.config/gcloud`, `.config/git`. The list is fixed in code and cannot be overridden.
5. **One owner per path.** Compared case-insensitively across built-in and custom harnesses alike: the same path may not be declared twice, and no path may be nested inside another, including an `instructionsFile` inside its own harness's `syncPaths`.

Consequences of rule 5: a harness that also reads a file a built-in already generates (Kilo Code and Devin CLI read `~/.claude/CLAUDE.md`) is declared without that file. A file read by several harnesses (`~/.agents/AGENTS.md`) is declared once, under one id, and gets one overlay.

Symlinks and junctions at custom paths follow the existing mirroring rules exactly; there is no new rule. The same rule set applies whether a declaration was typed locally or arrived through a pull, and it is checked every time the file is read.

### Authoring ([#53](https://github.com/floklein/git-agents/issues/53))

- **`/git-agents harness <request>`** is freeform, like `edit`. The agent interprets the request (add, change, remove), drafts the complete set of declarations, and the gate shows the exact diff of the declarations file before anything is written. With no request, it lists the built-in and custom harnesses and asks what to change.
- **`harness-stage`** takes the complete proposed set (`{"harnesses": {...}}`; the scripts write `version`), validates it against the shape and the path rules, and renders the exact file diff plus the paths that start or stop syncing. For a removal it also renders the repo files that will be deleted and the content of the overlay that will be deleted, and states that home files are left untouched. An invalid proposal is rejected with every problem listed; nothing is written.
- **`harness-apply`** writes the staged file in the clone, and refuses if the file changed since staging. The proposal replaces the whole file, so the pair works when the current file is invalid: it is the repair route.
- **After the write**, `harness` offers to continue into a sync, on an explicit yes: `sync`, or `sync unify` when an instructions file was declared or a removed harness had an overlay. It does not chain automatically.
- **Hand-editing the file stays possible.** An edit made directly in `~/.git-agents/` is picked up by the next sync and validated identically. The subcommand is the documented route; the agent itself never hand-edits the file.
- `setup` is unchanged.

### An invalid declarations file ([#53](https://github.com/floklein/git-agents/issues/53))

- **Invalid means stop, for the whole file.** `transport-begin`, `transport-commit`, `gather`, `stage`, `apply` and `propagate` refuse with one typed error (`invalid-harness-declarations`) that lists each problem and its remedy. One bad declaration blocks syncing for the built-ins too; nothing is skipped, because skipping would make machines disagree about the harness set.
- **`status` never fails.** It reports the built-ins as usual plus a caveat listing each problem and pointing at `/git-agents harness`.
- **An invalid file produced by a merge** is carried by `transport-begin` as an entry in the existing `conflicts` list, and `transport-commit` refuses until it is fixed. The fix goes through `transport-resolve` with corrected full contents, validated on the way in, or the user aborts. The home directory and the remote are untouched either way. One exception: a clone with no commit of its own (cloned while the remote was empty) that fast-forwards onto an invalid remote file has no merge to reopen, so `transport-begin` refuses with `invalid-harness-declarations` instead.
- An invalid declarations file never reads as "nothing declared".

### The first sync of a declaration ([#55](https://github.com/floklein/git-agents/issues/55))

- **Declining a sync never undoes a declaration.** `transport-begin` commits a pending change to the declarations file on its own, before it records the pre-sync point, whether the change was written by `harness` or by hand.
- **Look before mirroring.** `transport-begin` fetches, reads the remote's declarations file, and compares it with the merge base's. Paths the remote newly declares join the set that is mirrored; paths the remote removed leave it. An invalid remote file is ignored at this step and handled as an invalid merge result.
- **The declaration takes effect in the same run.** A machine with no file at a newly declared path contributes nothing; the merge brings the file and `transport-commit` mirrors it home.
- **A different file already at the declared path is an ordinary conflict.** The machine commits its own version first, so git reports a both-added conflict, and the existing conflict flow reconciles what is compatible and interviews on contradictions.
- **After the merge, the merged file is authoritative**: the incoming mirror, the gate listing and the last-sync record all use its set.
- **The gate** lists each path being synced for the first time under a newly declared harness, with its file count and total size ([#52](https://github.com/floklein/git-agents/issues/52)). There is no hard size limit.
- **Consent for a pulled declaration is that gate.** There is no per-machine acceptance. Declining aborts as usual and the declaration arrives again on the next sync; a machine cannot sync while refusing a declaration, and the way out is to remove it.
- **First convergence needs nothing special.** The first `sync unify` treats the instructions file like any file without markers. Until then `status` reports it as untracked and points at `sync unify`.

### Removing or changing a declaration ([#57](https://github.com/floklein/git-agents/issues/57))

Removing a declaration means git-agents stops managing those paths.

- **Home files are never touched**, on the removing machine or on any machine that pulls the removal. The `ga:` markers are left in an instructions file.
- **The repo is cleaned up in the same commit as the declaration change**: the harness's mirrored files, its overlay `canonical/overlays/<id>.md`, and its manifest entries are deleted, and the canonical version is recomputed. `harness-apply` applies these in the clone; for a hand-edited removal `transport-begin` applies them when it commits the pending declarations change.
- When the harness had an overlay, the canonical version changes and the other generated files read as stale until the next `sync unify`.
- **A removal pulled from another machine** is seen at fetch time, and its paths are left out of the mirror. Local edits to those files never become a conflict; they stay in the home directory, unsynced. The gate names the removed harness and states that the local files stay.
- **Changes are handled piece by piece**: a changed `name` only affects reports; an added path follows the first-sync rules; a removed path follows the removal rules; a moved `instructionsFile` keeps its overlay, with the old path removed and the new one treated as newly declared.
- **Re-declaring** a harness that was removed earlier is an ordinary fresh declaration.

### Compatibility ([#56](https://github.com/floklein/git-agents/issues/56))

The scripts always run as `npx -y git-agents@latest`, so only the skill text can be out of date. The scripts therefore stay safe when an older skill drives them:

1. Custom paths appear in the existing `outgoing` and `incoming` lists. The file count and size listing is carried in additional fields.
2. `transport-begin` returns no new `state` value.
3. Every refusal is a typed error with a message and a remedy.

An older skill has no `harness` subcommand; a user who types it gets the status fallback and the update offer. There is no manifest version bump and no update prompt beyond the existing closing-line offer. A machine running genuinely old scripts is outside the supported invocation: its `sync unify` drops the custom entries from the manifest and stamps a different canonical version, deletes nothing, and is repaired by the next `sync unify` from a current machine.

### Documentation

The README shows the five built-in harnesses written in the declaration shape, as worked examples for declaring a custom one, and `status` reports built-in and custom harnesses in that same shape:

```json
{
  "claude-code": { "name": "Claude Code", "instructionsFile": ".claude/CLAUDE.md", "syncPaths": [".claude/agents", ".claude/rules", ".claude/skills", ".claude/commands"] },
  "codex": { "name": "Codex", "instructionsFile": ".codex/AGENTS.md", "syncPaths": [".codex/agents", ".agents/skills"] },
  "cursor": { "name": "Cursor", "syncPaths": [".cursor/agents", ".cursor/skills", ".cursor/commands"] },
  "gemini-cli": { "name": "Gemini CLI", "instructionsFile": ".gemini/GEMINI.md", "syncPaths": [".gemini/agents", ".gemini/commands", ".gemini/skills"] },
  "opencode": { "name": "OpenCode", "instructionsFile": ".config/opencode/AGENTS.md", "syncPaths": [".config/opencode/agents", ".config/opencode/commands", ".config/opencode/skills"] }
}
```

The README states that these are built in and cannot be put in the declarations file. In `status`, each entry of `harnesses[]` carries `builtIn` beside `instructionsFile`, and its `syncPaths` still lists the instructions file first, as older skills expect.

## The transport workflow: bare `sync` ([#26](https://github.com/floklein/git-agents/issues/26), [#27](https://github.com/floklein/git-agents/issues/27))

**The sync state is just git.** Configs are treated independently, per path, and copied to and from the repo; the clone's history is the per-machine sync state, so there is no custom base tracking. In order, each write gated:

1. **Begin.** `transport-begin` commits a pending change to the declarations file ahead of the pre-sync point, fetches and reads the remote's declarations file so that newly declared paths are mirrored and removed ones are not ([#55](https://github.com/floklein/git-agents/issues/55), [#57](https://github.com/floklein/git-agents/issues/57)), mirrors local harness files into the clone, commits them under the existing scoped-commit safety rules, then attempts the merge from origin. Git detects conflicts per file against the real merge base. It refuses when the local declarations file is invalid ([#53](https://github.com/floklein/git-agents/issues/53)).
2. **Clean path.** No conflicts: the gate shows what will change on both sides, including each path synced for the first time under a newly declared harness with its file count and total size, and any harness another machine removed ([#52](https://github.com/floklein/git-agents/issues/52)); on Yes, `transport-commit` pushes, then mirrors the merged result home.
3. **Conflict path.** For each conflicted file: git already merged non-overlapping edits silently. The agent **reconciles compatible overlapping edits itself** (keep both additions, honor both changes) and **interviews the user only when the sides contradict**; binary or opaque both-modified files are always a pick-a-side interview. Resolutions land via `transport-resolve`.
4. **Gate, then commit.** Every resolution, automatic or interviewed, shows as a diff before `transport-commit` completes the merge, pushes, and mirrors home. **No is the default**; declining runs `transport-abort`.

Instruction files carrying ga markers are **plain text** here; if a resolution mangles markers, drift detection later reports the file as unattributed and `sync unify` recovers it.

The **commit scope** is the sync paths of every harness, built-in and custom, plus the manifest, the canonical directory and the declarations file `.git-agents-harnesses.json`. A custom harness's paths are transported exactly like a built-in's. The declarations file is the one file here that is validated: an invalid merge result is carried in the conflict list and blocks `transport-commit` until it is fixed ([#53](https://github.com/floklein/git-agents/issues/53)).

**Deletions** need one per-machine complement to git: the home directory is not git-tracked, so the clone's history cannot say whether this machine ever held a path. `transport-commit` records which sync paths the home directory holds after each completed sync (an untracked machine-local file beside the config); a missing path counts as a deletion, in either direction, only when that record says this machine had it. A fresh machine therefore never reads as a mass deletion, and real deletions propagate instead of resurrecting. The record is written from the harness set of the merged declarations file, so a path whose declaration was removed drops out of it and is never read as a deletion ([#57](https://github.com/floklein/git-agents/issues/57)).

## The unify workflow: `sync unify` ([#9](https://github.com/floklein/git-agents/issues/9), [#10](https://github.com/floklein/git-agents/issues/10), [#28](https://github.com/floklein/git-agents/issues/28))

`sync unify` **subsumes bare sync**: one run transports, converges, regenerates, and pushes once at the end. The first run is simply the workflow facing its biggest diff (empty canonical, five divergent files); no separate merge wizard exists. Integrated order, each step gated:

1. **Transport.** The bare-sync workflow above, with `transport-commit`'s push deferred to the end.
2. **Gather + merge.** Scripts emit structured drift; the agent proposes the full merge result (core + overlays) in one pass, then asks the user targeted questions **only** on genuinely ambiguous chunks. Steady state is usually zero questions.
3. **Stage + confirm.** Scripts render exact per-file diffs (canonical plus every generated file, a custom harness's instructions file included). Nothing is written until the user explicitly confirms; **No is the default**. The model's own summary is never the gate.
4. **Apply + regenerate.** Scripts write canonical and regenerate all copies, update the manifest. Regeneration lives **only** here: because unify always regenerates before pushing, the remote's copies are never stale relative to the remote canonical, and bare sync transports them as plain files. Locally detected staleness is reported by `status`, which points at `sync unify`.
5. **Push.** One push covering transport and convergence, under the existing safety rules; the run may record several scoped commits along the way (local state, merge, regeneration).

There is **no by-hand fallback**: scripts are skill-internal. A machine without a working agent does not sync.

## Onboarding ([#13](https://github.com/floklein/git-agents/issues/13))

Onboarding is **setup only, never merging**, and lives behind the explicit `setup` subcommand:

1. `npx git-agents`: a thin bootstrap whose only job is to run `npx skills add floklein/git-agents`, placing the SKILL.md into every harness path (the skills CLI owns per-harness placement).
2. **Docs, README, and the bootstrap's closing message all instruct the user to run `/git-agents setup` first.** Setup walks onboarding conversationally: the agent asks the remote preference (GitHub CLI or custom URL), the scripts run `gh` repo creation and clone deterministically.
3. Routing is the safety net, not the documented path: any other subcommand invoked before the `~/.git-agents` clone exists routes to `setup` first, then offers to continue the original subcommand.
4. The first `/git-agents sync unify` after setup performs the initial reconciliation through the normal workflow.

## Distribution and migration ([#13](https://github.com/floklein/git-agents/issues/13))

- **npm remains the carrier** of the deterministic scripts; updates flow through npm. The skill invokes the npm-installed package internally.
- **The Ink TUI is removed in the release that ships the skill.** `npx git-agents` becomes bootstrap-only from day one. `ga pull` / `ga push` CLI entry points are removed with it; machine sync's behavior and data model (snapshots, scoped commits, `.git-agents-sync.json`, junction/executable handling) are preserved behind the script surface.
- Migration for existing users: running the new `npx git-agents` on a configured machine skips remote setup (config exists) and only installs the skill. Release notes state the TUI removal and the new invocation model.

## Manifest extensions ([#10](https://github.com/floklein/git-agents/issues/10))

`.git-agents-sync.json` (in the remote, as today) gains:

```jsonc
{
  // existing initialized-paths content unchanged
  "canonical": {
    "version": "<monotonic integer or content hash>",
    "core": "<sha256>",
    "overlays": { "claude": "<sha256>", "codex": "<sha256>" }
  },
  "generated": {
    "claude":   { "path": ".claude/CLAUDE.md",            "hash": "<sha256>", "canonicalVersion": "<v>" },
    "codex":    { "path": ".codex/AGENTS.md",             "hash": "<sha256>", "canonicalVersion": "<v>" },
    "gemini":   { "path": ".gemini/GEMINI.md",            "hash": "<sha256>", "canonicalVersion": "<v>" },
    "opencode": { "path": ".config/opencode/AGENTS.md",   "hash": "<sha256>", "canonicalVersion": "<v>" }
  }
}
```

Drift detection: a generated file whose hash differs from `generated.<h>.hash` has local edits (merge-back input); one whose `canonicalVersion` lags `canonical.version` is stale (regenerate). Both can be true; merge-back runs first.

A custom harness adds entries under its id to `canonical.overlays` (when it has an overlay) and to `generated` (when it has an instructions file). Both sections are open records, so the manifest format and its `version` do not change ([#56](https://github.com/floklein/git-agents/issues/56)). Removing a declaration deletes its entries ([#57](https://github.com/floklein/git-agents/issues/57)). A repo with no declarations has a manifest identical to what it was before custom harnesses existed.

## Per-harness caveats the implementation must handle ([#8](https://github.com/floklein/git-agents/issues/8))

- **Codex 32 KiB cap**: generated core + overlay + markers must be measured; warn during stage above ~28 KiB, hard-warn at the cap (Codex truncates silently).
- **`~/.codex/AGENTS.override.md`**: if present, it silently shadows the generated file; `status` must detect and surface it.
- **Gemini `context.fileName`**: if the user has renamed the context file in settings, the generated `GEMINI.md` may not be read; `status` must detect and surface it.
- **OpenCode fallback order**: OpenCode reads `~/.config/opencode/AGENTS.md` first; once generated it wins over the `~/.claude/CLAUDE.md` fallback, so no double-load, but both being generated identical copies makes the point moot by design.
- **Custom harnesses** get no harness-specific caveat detection; the Codex size warnings stay Codex-only. A harness that reads its own file and another harness's generated file loads the core twice, and this is not detected ([#52](https://github.com/floklein/git-agents/issues/52)).
- **Invalid declarations file**: `status` reports it as a caveat that lists each problem and points at `/git-agents harness` ([#53](https://github.com/floklein/git-agents/issues/53)).

## SKILL.md surface ([#13](https://github.com/floklein/git-agents/issues/13); surface reshaped per [#28](https://github.com/floklein/git-agents/issues/28); `harness` added per [#53](https://github.com/floklein/git-agents/issues/53))

- **User-invoked with subcommands.** The skill fires by name with an argument: `/git-agents setup`, `/git-agents sync`, `/git-agents sync unify`, `/git-agents edit <request>`, `/git-agents harness <request>`, `/git-agents status`. Frontmatter: `name: git-agents`, `disable-model-invocation: true`, and a human-facing one-line `description` ("Sync AI harness files and global instructions across machines and harnesses via git. Subcommands: setup, sync, sync unify, edit, harness, status."). Claude Code and Cursor honor `disable-model-invocation`; harnesses that treat it as an unknown field ignore it gracefully, and the lean description keeps context load near zero either way.
- **Subcommand router.** The body opens with a router: the first argument word selects `setup` (onboarding: remote config and clone), `sync` (transport), `edit` (freeform canonical edit, [#45](https://github.com/floklein/git-agents/issues/45)), `harness` (custom harness authoring, [#53](https://github.com/floklein/git-agents/issues/53)), or `status` (drift and caveat report). When the first word is `sync`, an optional second word `unify` selects the full convergence workflow; any other second word gets a hint listing `sync` and `sync unify`. When the first word is `edit` or `harness`, everything after it is the freeform request; `harness` with no request lists the built-in and custom harnesses and asks what to change. No argument, or an unknown first word, runs `status` and lists the surface. When the `~/.git-agents` clone is absent, **every branch routes to `setup`** before doing anything else. `pull` and `push` are no longer user subcommands.
- **Shared contract inline, branch detail disclosed.** What every branch needs stays in `SKILL.md`: the script command surface, the confirm gate (exact script-rendered diffs, No default), and the targeted-question style. What only some branches reach is disclosed to sibling reference files (the transport conflict flow, the unify flow, the harness authoring flow, the Cursor pointer instructions), keeping the router legible.
- **Harnesses are named, never counted.** `status`, `gather`, the gate and every skill text name a custom harness by its declared `name`, or by its id when there is none. No text states a number of harnesses or of generated files, since the set is no longer fixed ([#53](https://github.com/floklein/git-agents/issues/53)).
- **Bootstrap redirects** `setup`, `sync`, `edit`, `harness`, and `status` typed at the terminal into the skill; legacy `pull` and `push` arguments print that they merged into `/git-agents sync`.
- Per-harness invocation: Claude Code and Cursor `/git-agents <subcommand>`; Codex `$git-agents <subcommand>`; OpenCode via its `skill` tool; Gemini CLI shows its consent prompt on activation (expected, documented).

## Acceptance criteria

1. Fresh machine, any of the four file-bearing harnesses: bootstrap, in-harness setup, first `sync unify` converges five divergent files into canonical with the user answering only targeted questions, and every write preceded by an exact diff and explicit Yes.
2. Steady state: an edit made in any one harness file (including a harness-appended memory line) lands in canonical and all other copies after one `sync unify` with zero or few questions.
3. Bare `sync` between two machines: edits to different paths travel both ways in one run; edits to the same file produce a git conflict that the agent reconciles when compatible and interviews on when contradictory, with every resolution shown at the gate; declining aborts cleanly.
4. Bare `sync` never reads or writes `canonical/`, and a machine that only ever runs bare `sync` still receives regenerated copies produced by other machines' `sync unify` runs.
5. `status` surfaces the Codex override shadow, the Gemini rename, the near-cap warning, and local staleness pointing at `sync unify`.
6. Windows: all of the above with junction-aware paths, no symlinks created, POSIX exec bits preserved for synced files.
7. No token usage by file operations themselves; the model's involvement is limited to orchestration, conflict resolution, merge proposals, and questions.

Custom harnesses ([#48](https://github.com/floklein/git-agents/issues/48)):

8. **Nothing declared, nothing changed.** With no declarations file, every command behaves and writes exactly as before: the same canonical version, manifest and markers, and no file reads as stale after upgrading.
9. **Declaring.** `/git-agents harness` adds a harness whose `instructionsFile` is `.dsh/AGENTS.md`, through a gate that shows the exact diff of `.git-agents-harnesses.json`. The next sync pushes the declaration and the file, with the gate listing the new path, its file count and its total size. After one `sync unify`, the file is generated from the canonical with its own overlay, and every other machine receives it.
10. **A second machine with a different file** at the declared path gets a both-added conflict that the agent reconciles or interviews on; neither version is overwritten without being shown.
11. **Declining a sync** leaves the declaration in place on the declaring machine, and leaves the home directory untouched on a receiving machine.
12. **Path rules.** `harness-stage` rejects, with the problem named: `.dsh` (one segment), `.ssh/config` (denylist), `.git-agents/x` (reserved), `.claude/skills/x` (nested inside a built-in path), a path declared twice, and the id `claude` (reserved).
13. **Invalid file.** With an invalid declarations file, `transport-begin`, `gather`, `stage`, `apply` and `propagate` refuse with every problem listed, `status` still reports the built-ins plus a caveat, and `/git-agents harness` repairs the file. An invalid merge result blocks `transport-commit` until `transport-resolve` supplies valid contents.
14. **Removal.** Removing a declaration deletes its repo copies, overlay and manifest entries in one commit and changes no file in any home directory. A machine that pulls the removal reports it at the gate and sees no conflict, even with local edits to those files.
15. **Older skill.** A skill that predates custom harnesses, driving the current scripts, still completes a sync of a repo that declares one, and its gate shows the custom paths among the incoming and outgoing changes.
