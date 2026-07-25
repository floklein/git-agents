# git-agents

A terminal UI tool to sync portable AI coding harness files across machines using git.

Supports five harnesses: **Claude Code**, **Codex**, **Cursor**, **Gemini CLI**, and **OpenCode**.

## What it does

`ga` syncs only your authored agents, instructions, commands, rules, and skills with a remote git repository. Machine-specific and generated state stays local.

## Quick start

```bash
npx git-agents@latest
```

## Install

```bash
npm i -g git-agents
```

### From source

```bash
git clone https://github.com/floklein/git-agents.git
cd git-agents
npm install
npm run build
npm link   # makes `ga` and `git-agents` available globally
```

## Usage

```bash
ga              # interactive TUI
ga pull         # pull remote harness files to local
ga push         # push local harness files to remote
```

## Features

### Setup

On first launch, `ga` walks you through setup:

1. **Choose a remote:** GitHub CLI (`gh`) or a custom git repo URL
2. **GitHub CLI path:** auto-creates a private `git-agents-remote` repo on your account
3. **Custom git path:** provide any accessible git remote URL
4. Clones the repo to `~/.git-agents` and saves your config

### Pull / Push

Both operations show a comparison summary before doing anything:

```
  Remote: 12 files         Local: 10 files

  Claude Code
  + .claude/agents
  ~ .claude/CLAUDE.md

  Codex
  = .agents/skills

  Confirm pull? [No, cancel] [Yes, pull]
```

**No is always the default**. Nothing happens unless you explicitly confirm.

After confirmation, changed paths are mirrored from the source side. A harness with none of its selected paths at the source is skipped, so pushing from a machine without that harness does not erase its remote files. Push commits are limited to the listed harness paths.

### Edit config

Select **Edit Config** from the main menu to reconfigure your remote at any time.

## Requirements

- [Node.js](https://nodejs.org) 22 or newer
- npm
- [git](https://git-scm.com)
- [GitHub CLI](https://cli.github.com) *(only if using the GH CLI remote option)*

## Supported harnesses

Only the paths below are synced. A trailing `/` means the full user-authored directory tree.

| Harness | Synced paths |
|---------|--------------|
| Claude Code | `~/.claude/CLAUDE.md`<br>`~/.claude/agents/`<br>`~/.claude/commands/`<br>`~/.claude/rules/`<br>`~/.claude/skills/` |
| Codex | `~/.codex/AGENTS.md`<br>`~/.codex/agents/`<br>`~/.agents/skills/` |
| Cursor | `~/.cursor/agents/`<br>`~/.cursor/commands/`<br>`~/.cursor/rules/`<br>`~/.cursor/skills/` |
| Gemini CLI | `~/.gemini/GEMINI.md`<br>`~/.gemini/agents/`<br>`~/.gemini/commands/`<br>`~/.gemini/skills/` |
| OpenCode | `~/.config/opencode/AGENTS.md`<br>`~/.config/opencode/agents/`<br>`~/.config/opencode/commands/`<br>`~/.config/opencode/skills/` |

Generated state, general settings, authentication data, caches, sessions, and managed installs are excluded. Everything outside the paths above is ignored.

Paths committed by older releases remain in the remote checkout for safe manual cleanup. Current sync ignores them and does not copy, stage, or commit them.
