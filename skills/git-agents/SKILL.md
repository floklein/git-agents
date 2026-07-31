---
name: git-agents
description: Sync AI harness files and global instructions across machines and harnesses via git. Subcommands: setup, sync, pull, push, status.
disable-model-invocation: true
---

# git-agents

You orchestrate; deterministic scripts do every file operation. Run them with:

```
npx -y git-agents --internal <command> [--input <json>]
```

Every command prints exactly one JSON envelope: `{"ok":true,"result":...}` or `{"ok":false,"error":{"code":"...","message":"..."}}`. Relay error messages with their remedy; never edit synced files by hand; never write anything except through the gate below.

The command surface:

| Command | Effect | Writes? |
| --- | --- | --- |
| `status` | Config, canonical version, generated states, drift, caveats | no |
| `setup` | Onboarding: remote choice, repo creation, clone | clone + config |
| `pull` / `push` | Machine sync: preview, then execute with the previewed rows | on execute |
| `gather` | Collect drift vs canonical with attribution and input hashes | no |
| `stage` | Accept a proposed canonical, render exact diffs | stage file |
| `apply` | Write the staged canonical and regenerate all copies | gated |
| `propagate` | Regenerate harness copies from the current canonical | gated |
| `install-pointer-docs` | Print the Cursor pointer rule with resolved paths | no |

## Router

The first word of the arguments selects the subcommand: `setup`, `sync`, `pull`, `push`, `status`. With no argument, or an unknown one, run the status subcommand and list the subcommands. Before any subcommand, if `status` reports `clonePresent: false`, run the setup branch first, then offer to continue what was originally asked.

## The gate

Before anything is written, show the user the exact script-rendered diffs and get an explicit confirmation. **No is the default**: anything but a clear yes means stop, and stopping costs nothing. Your own summary is never a substitute for the diffs.

## Subcommands

### status

Run `status`. Report concisely: configured and clone state, canonical version, each generated file's state (current, stale, modified, untracked, missing, no-canonical), the drift summary, and every caveat with its remedy.

### setup

1. Run `status`. If configured with a clone present, report that and stop; reconfigure (with `force:true`) only if the user explicitly asks.
2. Ask the user's remote preference: GitHub CLI auto-create (a private `git-agents-remote` repo) or a custom git remote URL.
3. Run `setup` with `{"remote":"gh"}` or `{"remote":"git","repoUrl":"..."}`. On a typed error (`gh-not-installed`, `gh-not-authenticated`, `invalid-repo-url`, `clone-failed`), relay the message and help fix it before retrying.
4. Suggest `/git-agents sync` as the next step.

### pull

1. Run `pull` with no input and present the per-path changes grouped by harness (status plus hashes are in the result).
2. Gate: confirm with the user.
3. Run `pull` with `{"execute":true,"expected":[...]}` where `expected` is every previewed row flattened as `{agentId,path,status,localHash,remoteHash}`. Execute refuses to run without `expected`. On `stale-inputs`, re-preview and re-confirm.
4. Run `status`; if any generated file is `stale` (the pulled canonical is newer than its copies), run `propagate` and report which copies were regenerated.

### push

Same shape as pull, with the `push` command.

### sync

The full convergence workflow: pull, merge drift into the canonical, propagate, push. Read [references/sync-flow.md](references/sync-flow.md) and follow it exactly.

## Cursor

Cursor has no global instructions file, so it receives no generated copy; that is a documented limitation, not a bug. If the user works with Cursor, offer the one-time pointer rule: see [references/cursor-pointer.md](references/cursor-pointer.md).
