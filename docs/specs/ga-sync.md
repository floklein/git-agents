# ga sync: cross-harness instruction sync (spec)

Build-ready spec assembled from wayfinder map [floklein/git-agents#4](https://github.com/floklein/git-agents/issues/4), amended for the reshaped subcommand surface from map [floklein/git-agents#25](https://github.com/floklein/git-agents/issues/25). Each section links the decision ticket that holds its rationale.

## Overview

git-agents pivots to **skill-first, for the whole product** ([#7](https://github.com/floklein/git-agents/issues/7)). The product becomes an Agent Skill (a `SKILL.md` plus deterministic scripts) installed into all five supported harnesses: Claude Code, Codex, Cursor, Gemini CLI, OpenCode.

The user surface is four items ([#28](https://github.com/floklein/git-agents/issues/28)):

- `/git-agents sync`: **transport**. Configs are treated independently and copied to and from the repo, git-native, with agent-resolved conflicts. The canonical is never involved.
- `/git-agents sync unify`: **convergence**. Transport first, then the per-harness global instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, ...) merge into one canonical version and every copy regenerates.
- `/git-agents status`: read-only report.
- `/git-agents setup`: one-time onboarding.

Standing constraints (map Notes):

- Windows stays first-class.
- Machine sync keeps its behavior and data model; only its front end moves into the skill.
- All five harnesses covered from day one (Cursor with a documented limitation, see below).
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

## Architecture ([#7](https://github.com/floklein/git-agents/issues/7), [#13](https://github.com/floklein/git-agents/issues/13))

Three layers:

1. **SKILL.md** (`name`, `description`, `disable-model-invocation`), placed at `~/.claude/skills/git-agents/` and `~/.agents/skills/git-agents/` so all five harnesses discover it. It instructs the agent how to drive a sync conversation and which script commands to call.
2. **Deterministic scripts**, delivered by the npm package and invoked by the agent through an internal command surface (see below). They do all file I/O, git operations, diffing, and manifest bookkeeping. They never make semantic decisions.
3. **The agent** (whichever harness is hosting) orchestrates: runs scripts, performs the semantic merge, asks the user targeted questions, and requests confirmation before apply.

### Script command surface (internal)

Hidden subcommands of the npm binary, JSON in/out, no interactive prompts. Not documented for end users; the SKILL.md is their only caller. Minimum set:

| Command | Effect |
| --- | --- |
| `status` | Report config presence, harness file paths and hashes, canonical version, drift summary, caveats |
| `transport-begin` | Record the pre-sync point, mirror local harness files into the clone, commit them (scoped), fetch and attempt the merge from origin; report either the clean incoming/outgoing changes or the merge's touched paths plus the conflicted files with base, local, and remote contents |
| `transport-resolve` | Accept per-file resolutions: full contents for text, or a local/remote side pick (binary conflicts) |
| `transport-commit` | Complete the merge commit, mirror the merged result back to the home directory, and push; refuses without a transport in progress or while conflicts remain unresolved; distinguishes retryable push failures from origin-advanced rejection. Takes a defer-push option used by `sync unify` |
| `transport-abort` | Abort the in-progress merge and restore the recorded pre-sync state, including after a clean auto-merge |
| `gather` | Collect the harness files and canonical into a merge workspace; emit structured diffs vs canonical |
| `stage` | Accept a proposed canonical (core + overlays) from the agent; render exact per-file diffs of what apply would write |
| `apply` | Write staged results to canonical and harness files; update manifest; refuse if inputs changed since stage |
| `propagate` | Regenerate harness copies from the current canonical |
| `install-pointer-docs` | Print the Cursor pointer-rule text for the user to paste (see Cursor) |

All commands are idempotent and safe to re-run where the underlying git state allows; `transport-commit` and `apply` are the only ones that write outside the workspace and the clone. The former one-directional `pull` and `push` commands are superseded by the transport primitives ([#26](https://github.com/floklein/git-agents/issues/26)).

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
```

Cross-machine transport is therefore inherent to machine sync. No standing copy elsewhere in the home directory.

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

### Target files

| Harness | Generated file |
| --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| Gemini CLI | `~/.gemini/GEMINI.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| Cursor | none (see below) |

### Cursor ([#8](https://github.com/floklein/git-agents/issues/8))

Cursor has no global instructions file (verified; open feature request). Cursor is **excluded from automatic propagation**, as a documented limitation. Opt-in workaround, documented and printed by `install-pointer-docs`: a one-time manual User Rule in Cursor's settings that instructs the agent to read `~/.git-agents/canonical/core.md` (plus `overlays/cursor.md` if present) at session start. Revisit when Cursor ships global AGENTS.md support. The undocumented no-op `~/.cursor/rules` path is **dropped from the sync path list**.

## The transport workflow: bare `sync` ([#26](https://github.com/floklein/git-agents/issues/26), [#27](https://github.com/floklein/git-agents/issues/27))

**The sync state is just git.** Configs are treated independently, per path, and copied to and from the repo; the clone's history is the per-machine sync state, so there is no custom base tracking. In order, each write gated:

1. **Begin.** `transport-begin` mirrors local harness files into the clone, commits them under the existing scoped-commit safety rules, then fetches and attempts the merge from origin. Git detects conflicts per file against the real merge base.
2. **Clean path.** No conflicts: the gate shows what will change on both sides; on Yes, `transport-commit` mirrors the merged result home and pushes.
3. **Conflict path.** For each conflicted file: git already merged non-overlapping edits silently. The agent **reconciles compatible overlapping edits itself** (keep both additions, honor both changes) and **interviews the user only when the sides contradict**; binary or opaque both-modified files are always a pick-a-side interview. Resolutions land via `transport-resolve`.
4. **Gate, then commit.** Every resolution, automatic or interviewed, shows as a diff before `transport-commit` completes the merge, mirrors home, and pushes. **No is the default**; declining runs `transport-abort`.

Instruction files carrying ga markers are **plain text** here; if a resolution mangles markers, drift detection later reports the file as unattributed and `sync unify` recovers it. Deletion semantics keep riding the manifest's initialized-paths guard.

## The unify workflow: `sync unify` ([#9](https://github.com/floklein/git-agents/issues/9), [#10](https://github.com/floklein/git-agents/issues/10), [#28](https://github.com/floklein/git-agents/issues/28))

`sync unify` **subsumes bare sync**: one run transports, converges, regenerates, and pushes once at the end. The first run is simply the workflow facing its biggest diff (empty canonical, five divergent files); no separate merge wizard exists. Integrated order, each step gated:

1. **Transport.** The bare-sync workflow above, with `transport-commit`'s push deferred to the end.
2. **Gather + merge.** Scripts emit structured drift; the agent proposes the full merge result (core + overlays) in one pass, then asks the user targeted questions **only** on genuinely ambiguous chunks. Steady state is usually zero questions.
3. **Stage + confirm.** Scripts render exact per-file diffs (canonical plus the four generated files). Nothing is written until the user explicitly confirms; **No is the default**. The model's own summary is never the gate.
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

## Per-harness caveats the implementation must handle ([#8](https://github.com/floklein/git-agents/issues/8))

- **Codex 32 KiB cap**: generated core + overlay + markers must be measured; warn during stage above ~28 KiB, hard-warn at the cap (Codex truncates silently).
- **`~/.codex/AGENTS.override.md`**: if present, it silently shadows the generated file; `status` must detect and surface it.
- **Gemini `context.fileName`**: if the user has renamed the context file in settings, the generated `GEMINI.md` may not be read; `status` must detect and surface it.
- **OpenCode fallback order**: OpenCode reads `~/.config/opencode/AGENTS.md` first; once generated it wins over the `~/.claude/CLAUDE.md` fallback, so no double-load, but both being generated identical copies makes the point moot by design.

## SKILL.md surface ([#13](https://github.com/floklein/git-agents/issues/13); surface reshaped per [#28](https://github.com/floklein/git-agents/issues/28))

- **User-invoked with subcommands.** The skill fires by name with an argument: `/git-agents setup`, `/git-agents sync`, `/git-agents sync unify`, `/git-agents status`. Frontmatter: `name: git-agents`, `disable-model-invocation: true`, and a human-facing one-line `description` ("Sync AI harness files and global instructions across machines and harnesses via git. Subcommands: setup, sync, sync unify, status."). Claude Code and Cursor honor `disable-model-invocation`; harnesses that treat it as an unknown field ignore it gracefully, and the lean description keeps context load near zero either way.
- **Subcommand router.** The body opens with a router: the first argument word selects `setup` (onboarding: remote config and clone), `sync` (transport), or `status` (drift and caveat report). When the first word is `sync`, an optional second word `unify` selects the full convergence workflow; any other second word gets a hint listing `sync` and `sync unify`. No argument, or an unknown first word, runs `status` and lists the surface. When the `~/.git-agents` clone is absent, **every branch routes to `setup`** before doing anything else. `pull` and `push` are no longer user subcommands.
- **Shared contract inline, branch detail disclosed.** What every branch needs stays in `SKILL.md`: the script command surface, the confirm gate (exact script-rendered diffs, No default), and the targeted-question style. What only some branches reach is disclosed to sibling reference files (the transport conflict flow, the unify flow, the Cursor pointer instructions), keeping the router legible.
- **Bootstrap redirects** `setup`, `sync`, and `status` typed at the terminal into the skill; legacy `pull` and `push` arguments print that they merged into `/git-agents sync`.
- Per-harness invocation: Claude Code and Cursor `/git-agents <subcommand>`; Codex `$git-agents <subcommand>`; OpenCode via its `skill` tool; Gemini CLI shows its consent prompt on activation (expected, documented).

## Acceptance criteria

1. Fresh machine, any of the four file-bearing harnesses: bootstrap, in-harness setup, first `sync unify` converges five divergent files into canonical with the user answering only targeted questions, and every write preceded by an exact diff and explicit Yes.
2. Steady state: an edit made in any one harness file (including a harness-appended memory line) lands in canonical and all other copies after one `sync unify` with zero or few questions.
3. Bare `sync` between two machines: edits to different paths travel both ways in one run; edits to the same file produce a git conflict that the agent reconciles when compatible and interviews on when contradictory, with every resolution shown at the gate; declining aborts cleanly.
4. Bare `sync` never reads or writes `canonical/`, and a machine that only ever runs bare `sync` still receives regenerated copies produced by other machines' `sync unify` runs.
5. `status` surfaces the Codex override shadow, the Gemini rename, the near-cap warning, and local staleness pointing at `sync unify`.
6. Windows: all of the above with junction-aware paths, no symlinks created, POSIX exec bits preserved for synced files.
7. No token usage by file operations themselves; the model's involvement is limited to orchestration, conflict resolution, merge proposals, and questions.
