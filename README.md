# git-agents

An agent skill that syncs your portable AI coding harness files, and one canonical set of global instructions, across machines and harnesses using git.

Built in: **Claude Code**, **Codex**, **Cursor**, **Gemini CLI**, and **OpenCode**. Any other harness that reads its files from your home directory can be added as a [custom harness](#custom-harnesses).

## What it does

- **Across machines**: your authored agents, instructions, commands, rules, and skills travel through a private git remote. Machine-specific and generated state stays local.
- **Across harnesses**: one canonical instructions document (a shared core plus optional per-harness overlays) generates `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, and the instructions file of every custom harness, and edits made in any of them merge back.

Deterministic scripts do every file operation and render exact diffs; the agent in your harness orchestrates and handles the semantic merging. Nothing is ever written without showing you the diff first, and **No is always the default**.

## Quick start

1. Install the skill into your harnesses:

   ```bash
   npx git-agents@latest
   ```

   Installed once, updated in-session: whenever a newer git-agents release exists, any `/git-agents` command ends by offering the update; accept and the skill refreshes itself.

2. Open your coding agent and run:

   ```
   /git-agents setup
   ```

   Setup asks for your remote preference (GitHub CLI auto-creates a private `git-agents-remote` repo, or bring any git remote URL), then clones it to `~/.git-agents`.

3. Converge your instructions:

   ```
   /git-agents sync unify
   ```

If you skip step 2, any other subcommand routes you into setup first.

## Subcommands

| Subcommand | What it does |
|---|---|
| `/git-agents setup` | One-time onboarding: remote choice, repo creation, clone. Safe to re-run. |
| `/git-agents sync` | Transport: your configs travel to and from the repo independently, git-native. Conflicts are resolved by the agent (reconciled when compatible, interviewed when contradictory). The canonical is never involved. |
| `/git-agents sync unify` | The full convergence flow: transport, then merge drift into the canonical, regenerate every harness file, and push once. |
| `/git-agents edit <request>` | Freeform edit of your global instructions: the agent interprets the request (add, reword, remove), drafts it into the canonical in the right section, and runs the full convergence flow around it. |
| `/git-agents harness <request>` | Declare, change, or remove a custom harness: the agent drafts the declarations, shows the exact diff of the declarations file and the paths that start or stop syncing, then offers to sync. |
| `/git-agents status` | Config, canonical version, per-file state, drift, and caveats. Read-only. |

Every write is gated: the scripts render exact per-file diffs, and nothing happens until you explicitly confirm. Per harness: Claude Code and Cursor use `/git-agents <subcommand>`, Codex uses `$git-agents <subcommand>`, OpenCode invokes it through its skill tool, and Gemini CLI shows a consent prompt on skill activation, which is expected.

## The canonical model

Your global instructions live once, inside the sync repo:

```
~/.git-agents/
  canonical/
    core.md              shared by every harness
    overlays/<name>.md   optional per-harness extras
```

Each harness file is generated as core plus overlay, wrapped in `ga:` markers so later edits (yours or the harness's own memory writes) can be attributed and merged back. Because the canonical lives in the sync repo, it travels across machines with the ordinary push and pull.

### Cursor

Cursor has no global instructions file, so it receives no generated copy. This is a documented limitation, not a bug. Opt-in bridge: a one-time manual User Rule pointing Cursor at the canonical file; ask the skill about Cursor and it walks you through adding the rule, exact paths included.

## Synced paths

Only the paths below, plus those of your [custom harnesses](#custom-harnesses), are synced across machines. A trailing `/` means the full directory tree. Files matched by git ignore rules are still included inside these explicitly selected paths.

| Harness | Synced paths |
|---------|--------------|
| Claude Code | `~/.claude/CLAUDE.md` (generated)<br>`~/.claude/agents/`<br>`~/.claude/commands/`<br>`~/.claude/rules/`<br>`~/.claude/skills/` |
| Codex | `~/.codex/AGENTS.md` (generated)<br>`~/.codex/agents/`<br>`~/.agents/skills/` |
| Cursor | `~/.cursor/agents/`<br>`~/.cursor/commands/`<br>`~/.cursor/skills/` |
| Gemini CLI | `~/.gemini/GEMINI.md` (generated)<br>`~/.gemini/agents/`<br>`~/.gemini/commands/`<br>`~/.gemini/skills/` |
| OpenCode | `~/.config/opencode/AGENTS.md` (generated)<br>`~/.config/opencode/agents/`<br>`~/.config/opencode/commands/`<br>`~/.config/opencode/skills/` |

The canonical directory itself is part of the sync repo and needs no entry here. The previously synced `~/.cursor/rules/` path was removed: Cursor does not read a global rules directory.

Generated state, general settings, authentication data, caches, sessions, and managed installs outside the paths above are excluded. Everything inside a selected directory is treated as portable content, so keep machine-specific files outside it.

Inside the selected directories, folders that a tool manages per machine are never synced, in either direction, and sync never overwrites or deletes them: `~/.claude/skills/synced/` (Claude Code's claude.ai skill sync), any `.trash/` or `.staging/` folder, `.DS_Store` files, and git-agents' own temporary `.<name>.git-agents-*` names. To exclude more, list patterns in `.git-agents-excludes` at the root of the sync repo clone (`~/.git-agents/`), one per line (`#` for comments): a name without a `/` matches at any depth (`notes`, `*.log`), a path with a `/` matches from your home directory (`.claude/skills/local-only`). The file is synced, so every machine applies it. Excluded files an earlier version committed leave the repo on the next sync; they stay in every home directory.

On Windows, a selected leaf directory junction syncs the contents of its target. Pulling into an existing junction updates that target without replacing the junction. POSIX executable state is preserved for synced files.

## Custom harnesses

A harness that is not built in can be declared, and from then on it is treated exactly like a built-in: every machine sharing the repo transports its paths and generates its instructions file from the canonical, whether or not the harness is installed there. Ask for it in plain words:

```
/git-agents harness add DeepSeek Harness: instructions in ~/.dsh/AGENTS.md, skills in ~/.dsh/skills
```

The agent drafts the declaration and shows the exact diff of the declarations file, with the paths that start syncing, before anything is written. Run `/git-agents harness` alone to list the built-in and custom harnesses.

### The declarations file

Declarations live in `.git-agents-harnesses.json` at the root of the sync repo (`~/.git-agents/`). The file is committed and reaches every machine through an ordinary sync; there is no per-machine opt-in. Without the file, nothing changes.

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

- The key is the harness id: lowercase letters, digits, and hyphens, starting with a letter, at most 32 characters. It names the overlay `canonical/overlays/<id>.md` and cannot be changed; changing it removes the harness and declares a new one.
- `instructionsFile` (optional): the harness's global instructions file. `sync unify` generates it from the canonical and merges edits back. It syncs on its own and is not repeated in `syncPaths`.
- `syncPaths` (optional): files or directories that only sync, like a built-in's.
- `name` (optional): the display name, defaulting to the id.
- At least one of `instructionsFile` and `syncPaths` is required. Unknown fields make the file invalid.

The built-in harnesses, written in the same shape, make good worked examples. They are built in: they cannot be put in the declarations file, and their ids (`claude-code`, `claude`, `codex`, `cursor`, `gemini-cli`, `gemini`, `opencode`) cannot be used for a custom harness.

```json
{
  "claude-code": { "name": "Claude Code", "instructionsFile": ".claude/CLAUDE.md", "syncPaths": [".claude/agents", ".claude/rules", ".claude/skills", ".claude/commands"] },
  "codex": { "name": "Codex", "instructionsFile": ".codex/AGENTS.md", "syncPaths": [".codex/agents", ".agents/skills"] },
  "cursor": { "name": "Cursor", "syncPaths": [".cursor/agents", ".cursor/skills", ".cursor/commands"] },
  "gemini-cli": { "name": "Gemini CLI", "instructionsFile": ".gemini/GEMINI.md", "syncPaths": [".gemini/agents", ".gemini/commands", ".gemini/skills"] },
  "opencode": { "name": "OpenCode", "instructionsFile": ".config/opencode/AGENTS.md", "syncPaths": [".config/opencode/agents", ".config/opencode/commands", ".config/opencode/skills"] }
}
```

### Path rules

Every path is relative to the home directory and written the same way on every OS: no `~`, no environment variables, no per-OS variants. A harness whose location differs by OS needs one declaration per location. Every declared path must be:

1. **Portable**: forward slashes, no `..`, no empty or `.` segments, and every segment valid on Windows (none of `< > : " | ? *`, no trailing dot or space, no device names such as `con` or `nul`).
2. **At least two segments deep**: `.dsh/skills`, never `.dsh` or `.bashrc`.
3. **Outside reserved names**: the first segment is not `.git`, `.git-agents`, or `canonical`.
4. **Outside credential directories**: not `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.config/gh`, `.config/gcloud`, or `.config/git`, nor inside one. This list cannot be overridden.
5. **Owned once**: no path is declared twice or nested inside another, across built-in and custom harnesses, compared case-insensitively. A harness that also reads a file a built-in already generates (such as `~/.claude/CLAUDE.md`) is declared without that file.

### What happens next

- **The first sync** pushes the declaration with the files, and its confirmation lists each newly synced path with its file count and total size. Other machines receive both on their next sync; a machine that already holds a different file at that path gets an ordinary conflict, resolved like any other. Declining a sync never undoes a declaration.
- **The first `sync unify`** generates the new instructions file from the canonical; until then `status` reports it as untracked.
- **Removing a declaration** stops the sync of its paths. Its copies, overlay, and manifest entries are deleted from the repo; files in the home directory are never touched, on any machine. When the harness had an overlay, run `sync unify` afterwards.

You can also edit the file by hand in `~/.git-agents/`: the next sync validates it the same way.

## Status caveats worth knowing

`/git-agents status` warns when something would silently break the sync:

- `~/.codex/AGENTS.override.md` exists and shadows the generated file.
- Gemini's `context.fileName` setting no longer includes `GEMINI.md`.
- The Codex instructions file approaches its 32 KiB cap (Codex truncates silently at the cap).
- `.git-agents-harnesses.json` is invalid. Every sync stops, for the built-in harnesses too, until the file is fixed; the caveat lists each problem, and `/git-agents harness` repairs it.

## Migrating from the TUI (0.x)

Version 1.0.0 removed the interactive TUI and the `ga pull` / `ga push` terminal commands.

- Your remote, clone, and synced files are untouched; the same `~/.git-agents` config keeps working.
- Run `npx git-agents@latest` once to install the skill; setup detects the existing config and leaves it alone.
- `ga pull` and `ga push` merged into `/git-agents sync`, which now moves changes in both directions in one run and resolves conflicts instead of overwriting one side.
- Paths committed by older releases remain in the remote checkout for safe manual cleanup. Current sync ignores them and does not copy, stage, or commit them.

## Requirements

- [Node.js](https://nodejs.org) 22 or newer, and npm
- [git](https://git-scm.com)
- [GitHub CLI](https://cli.github.com) *(only for the GH remote option)*
- At least one supported coding agent to drive the skill

## From source

```bash
git clone https://github.com/floklein/git-agents.git
cd git-agents
npm install
npm run check   # typecheck, tests, build
```
