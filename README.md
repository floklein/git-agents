# git-agents

A terminal UI tool to sync your AI agents and skills across machines using git.

Supports **OpenCode**, **Claude Code**, **Codex**, **Cursor**, and [41 more](#supported-agents).

## What it does

`ga` keeps your AI agent directories in sync with a remote git repository — so your custom skills follow you everywhere.

## Install

```bash
bun install --global git-agents
```

Or with npm:

```bash
npm install --global git-agents
```

> **Requires [Bun](https://bun.sh)** — install it first if you haven't already.

### From source

```bash
bun install
bun link   # makes `ga` and `git-agents` available globally
```

## Usage

```bash
ga              # interactive TUI
ga pull         # pull remote agents to local
ga push         # push local agents to remote
```

## First run

On first launch, `ga` walks you through setup:

1. **Choose a remote** — GitHub CLI (`gh`) or a custom git repo URL
2. **GitHub CLI path** — auto-creates a private `git-agents-remote` repo on your account
3. **Custom git path** — provide any accessible git remote URL
4. Clones the repo to `~/.git-agents` and saves your config

## Pull / Push

Both operations show a comparison summary before doing anything:

```
  Remote: 12 skills        Local: 10 skills

  + new-skill-a
  + new-skill-b
  ~ updated-skill

  8 skills unchanged

  Confirm pull? [No, cancel] [Yes, pull]
```

**No is always the default** — nothing happens unless you explicitly confirm.

## Edit config

Select **Edit Config** from the main menu to reconfigure your remote at any time.

## Requirements

- [Bun](https://bun.sh)
- [git](https://git-scm.com)
- [GitHub CLI](https://cli.github.com) *(only if using the GH CLI remote option)*

## Supported agents

| Agent | Global path |
|-------|-------------|
| Amp | `~/.config/agents/` |
| Antigravity | `~/.gemini/antigravity/` |
| Augment | `~/.augment/` |
| IBM Bob | `~/.bob/` |
| Claude Code | `~/.claude/` |
| Cline | `~/.agents/` |
| CodeBuddy | `~/.codebuddy/` |
| Codex | `~/.codex/` |
| Command Code | `~/.commandcode/` |
| Continue | `~/.continue/` |
| Cortex Code | `~/.snowflake/cortex/` |
| Crush | `~/.config/crush/` |
| Cursor | `~/.cursor/` |
| Deep Agents | `~/.deepagents/agent/` |
| Droid | `~/.factory/` |
| Firebender | `~/.firebender/` |
| Gemini CLI | `~/.gemini/` |
| GitHub Copilot | `~/.copilot/` |
| Goose | `~/.config/goose/` |
| iFlow CLI | `~/.iflow/` |
| Junie | `~/.junie/` |
| Kilo Code | `~/.kilocode/` |
| Kimi Code CLI | `~/.config/agents/` |
| Kiro CLI | `~/.kiro/` |
| Kode | `~/.kode/` |
| MCPJam | `~/.mcpjam/` |
| Mistral Vibe | `~/.vibe/` |
| Mux | `~/.mux/` |
| OpenClaw | `~/.openclaw/` |
| OpenCode | `~/.config/opencode/` |
| OpenHands | `~/.openhands/` |
| Pi | `~/.pi/agent/` |
| Pochi | `~/.pochi/` |
| Qoder | `~/.qoder/` |
| Qwen Code | `~/.qwen/` |
| Replit | `~/.config/agents/` |
| Roo Code | `~/.roo/` |
| Trae | `~/.trae/` |
| Trae CN | `~/.trae-cn/` |
| Universal | `~/.config/agents/` |
| Warp | `~/.agents/` |
| Windsurf | `~/.codeium/windsurf/` |
| Zencoder | `~/.zencoder/` |
| Neovate | `~/.neovate/` |
| AdaL | `~/.adal/` |
