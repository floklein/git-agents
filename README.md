# git-agents

An agent skill that syncs your portable AI coding harness files, and one canonical set of global instructions, across machines and harnesses using git.

Supports five harnesses: **Claude Code**, **Codex**, **Cursor**, **Gemini CLI**, and **OpenCode**.

## What it does

- **Across machines**: your authored agents, instructions, commands, rules, and skills travel through a private git remote. Machine-specific and generated state stays local.
- **Across harnesses**: one canonical instructions document (a shared core plus optional per-harness overlays) generates `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md` for every harness, and edits made in any of them merge back.

Deterministic scripts do every file operation and render exact diffs; the agent in your harness orchestrates and handles the semantic merging. Nothing is ever written without showing you the diff first, and **No is always the default**.

## Quick start

1. Install the skill into your harnesses:

   ```bash
   npx git-agents@latest
   ```

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

Only the paths below are synced across machines. A trailing `/` means the full directory tree. Files matched by git ignore rules are still included inside these explicitly selected paths.

| Harness | Synced paths |
|---------|--------------|
| Claude Code | `~/.claude/CLAUDE.md` (generated)<br>`~/.claude/agents/`<br>`~/.claude/commands/`<br>`~/.claude/rules/`<br>`~/.claude/skills/` |
| Codex | `~/.codex/AGENTS.md` (generated)<br>`~/.codex/agents/`<br>`~/.agents/skills/` |
| Cursor | `~/.cursor/agents/`<br>`~/.cursor/commands/`<br>`~/.cursor/skills/` |
| Gemini CLI | `~/.gemini/GEMINI.md` (generated)<br>`~/.gemini/agents/`<br>`~/.gemini/commands/`<br>`~/.gemini/skills/` |
| OpenCode | `~/.config/opencode/AGENTS.md` (generated)<br>`~/.config/opencode/agents/`<br>`~/.config/opencode/commands/`<br>`~/.config/opencode/skills/` |

The canonical directory itself is part of the sync repo and needs no entry here. The previously synced `~/.cursor/rules/` path was removed: Cursor does not read a global rules directory.

Generated state, general settings, authentication data, caches, sessions, and managed installs outside the paths above are excluded. Everything inside a selected directory is treated as portable content, so keep machine-specific files outside it.

On Windows, a selected leaf directory junction syncs the contents of its target. Pulling into an existing junction updates that target without replacing the junction. POSIX executable state is preserved for synced files.

## Status caveats worth knowing

`/git-agents status` warns when something would silently break the sync:

- `~/.codex/AGENTS.override.md` exists and shadows the generated file.
- Gemini's `context.fileName` setting no longer includes `GEMINI.md`.
- The Codex instructions file approaches its 32 KiB cap (Codex truncates silently at the cap).

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
