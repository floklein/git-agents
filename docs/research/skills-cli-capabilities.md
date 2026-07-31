# Research: skills CLI capabilities for updating and pinning installed skills

Resolves [#37](https://github.com/floklein/git-agents/issues/37) (child of map issue [#36](https://github.com/floklein/git-agents/issues/36)).

Subject: the `skills` npm package (the CLI our bootstrap invokes via `npx -y skills add floklein/git-agents` in `src/index.ts`).

Primary sources used:

- npm metadata: `npm view skills repository version` returns `git+https://github.com/vercel-labs/skills.git`, version `1.5.21` (checked 2026-08-01).
- Source code at [vercel-labs/skills](https://github.com/vercel-labs/skills), commit `1164afa5f0e21ebd01e6fc11249759353f494ad1` (HEAD of `main` at time of research). All file citations below are permalinks to that commit.
- Local CLI output: `npx -y skills@1.5.21 --help`.

## TL;DR

1. **Update in place**: yes, a real `skills update [skills...]` command exists (alias `upgrade`), and re-running `add` also refreshes because installs wipe and recreate the skill directory.
2. **Pinning**: yes, `owner/repo#ref` (or a GitHub `/tree/<ref>` URL) installs from a branch or tag; the ref is recorded in the lock file and honored by `update`; arbitrary commit SHAs are not supported by the git clone path.
3. **Install locations**: canonical copy in `.agents/skills/` (project) or `~/.agents/skills/` (global); Claude Code gets a symlink/junction at `.claude/skills/` (project) or `~/.claude/skills/` (global); Codex, Cursor, Gemini CLI, and OpenCode share the canonical `.agents/skills/` at project level and have their own global dirs (`~/.codex/skills`, `~/.cursor/skills`, `~/.gemini/skills`, `~/.config/opencode/skills`).
4. **Re-add**: overwrites cleanly (rm-then-recreate), shows an "overwrites:" line in the summary, prompts for confirmation only without `-y`; no duplication.
5. **Update-flow building blocks**: two lock files with version metadata (global `~/.agents/.skill-lock.json` with a GitHub tree SHA per skill, project `./skills-lock.json` with a content SHA-256), `skills list --json`, `skills remove -y`, and `-y` on every mutating command makes the whole flow drivable without a TTY (the CLI even auto-detects agent environments and goes non-interactive).

## 1. Updating an already-installed skill

**Yes, twice over.**

`skills update [skills...]` (alias `upgrade`) is a first-class command:

- `--help` output lists: `update [skills...]   Update skills to latest versions (alias: upgrade)` with options `-g/--global`, `-p/--project`, `-y/--yes`.
- Documented in the README with examples (`npx skills update`, `npx skills update my-skill`, `npx skills update -g`, `npx skills update -y`): [README.md lines 152-177](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/README.md).

How it decides a skill is outdated ([src/update.ts](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/update.ts)):

- GitHub sources: fetches the repo tree via the GitHub Trees API (`fetchRepoTree(source, firstEntry.ref, ...)`) and compares the skill folder's tree SHA against the `skillFolderHash` recorded in the lock file (`updateGlobalSkills`, around lines 541-577).
- Generic git sources: shallow-clones and compares a computed hash (around lines 582-614).
- When a change is detected, it literally re-runs itself: `spawnSync(process.execPath, [cliEntry, 'add', installUrl, ..., '-y'])` (lines 678-691). So "update" is implemented as "re-add non-interactively".

Re-running `add` manually refreshes too: the installer deletes and recreates the destination directory on every install (`cleanAndCreateDirectory`: `rm(path, { recursive: true, force: true })` then `mkdir`, [src/installer.ts lines 163-170](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/installer.ts)).

## 2. Installing from a specific ref/tag (pinning)

**Yes, for branches and tags.** Three equivalent syntaxes, all parsed in [src/source-parser.ts](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/source-parser.ts):

- Fragment ref on any git-like source: `skills add owner/repo#v1.2.0`, optionally combined with a skill filter as `owner/repo#v1.2.0@skill-name` (`parseFragmentRef`, lines 204-234; applied to shorthand sources at lines 442-463).
- GitHub tree URL: `skills add https://github.com/owner/repo/tree/<ref>[/subpath]` (lines 352-372).
- GitLab tree URL equivalent (lines 389-415).

The parsed `ref` flows into both fetch paths:

- git clone path: `cloneRepo(url, ref)` runs `git clone --depth 1 --branch <ref>` ([src/git.ts line 241](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/git.ts)). `--branch` accepts branch names and tags but **not** arbitrary commit SHAs, so pin to a tag or branch, not a commit.
- GitHub API fast path: `fetchRepoTree(ownerRepo, ref)` hits the Trees API with the ref; with no ref it tries `HEAD`, `main`, `master` in order ([src/blob.ts lines 179-219](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/blob.ts)).

The ref is persisted in both lock files ("Branch or tag ref used for installation (for ref-aware updates)", [src/skill-lock.ts line 22-23](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/skill-lock.ts), [src/local-lock.ts lines 20-21](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/local-lock.ts)), and `skills update` checks against that recorded ref (`fetchRepoTree(source, firstEntry.ref, ...)` and `cloneRepo(sourceUrl, firstEntry.ref)` in src/update.ts).

Consequence for us: pinning to an immutable tag freezes the skill (`update` will keep reporting "up to date" for that ref); installing from HEAD (what we do today) means `update` tracks the default branch. Both behaviors are exactly what a "pin or track" story needs.

## 3. Install locations per harness

Two-layer model ([src/installer.ts](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/installer.ts)): the skill is copied to a **canonical** directory, then **symlinked** (junction on Windows, line 255) into each non-universal agent's directory. `--copy` skips symlinks and copies into each agent dir directly. Agents whose `skillsDir` is `.agents/skills` are "universal" and read the canonical dir directly, no extra link.

Canonical: project `<cwd>/.agents/skills/<skill>`, global `~/.agents/skills/<skill>` (`getCanonicalSkillsDir`, installer.ts line ~100; `AGENTS_DIR = '.agents'`).

Per harness ([src/agents.ts](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/agents.ts)):

| Harness | Project install | Global install |
| --- | --- | --- |
| Claude Code | `.claude/skills/<skill>` (link to `.agents/skills`) | `~/.claude/skills/<skill>` (respects `$CLAUDE_CONFIG_DIR`), lines 143-151 |
| Codex | `.agents/skills/<skill>` (universal) | `~/.codex/skills/<skill>` (respects `$CODEX_HOME`), lines 211-218 |
| Cursor | `.agents/skills/<skill>` (universal) | `~/.cursor/skills/<skill>`, lines 256-263 |
| Gemini CLI | `.agents/skills/<skill>` (universal) | `~/.gemini/skills/<skill>`, lines 332-340 |
| OpenCode | `.agents/skills/<skill>` (universal) | `~/.config/opencode/skills/<skill>` (XDG config home), lines 523-530 |

Note: for project installs, symlinks into a non-universal agent dir are skipped when that agent's root dir does not exist, except Claude Code which is always linked (installer.ts around lines 374-391).

## 4. Re-adding an existing skill

**Clean overwrite, no duplicates.**

- `add` checks in advance which targets already contain the skill and prints `overwrites: <agents>` in the installation summary ([src/add.ts lines 808-845, 1606-1665](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/add.ts)).
- Without `-y` there is a single `Proceed with installation?` confirm (add.ts lines 850-857 and 1717-1720). With `-y` (or `--all`) it proceeds silently.
- The actual install removes the existing directory first (`cleanAndCreateDirectory`, installer.ts lines 163-170), so renamed or deleted files from the previous version do not linger.
- The lock entry is upserted under the same skill name, preserving `installedAt` and refreshing `updatedAt` (`addSkillToLock`, skill-lock.ts lines 209-225).

## 5. Everything else load-bearing for a "check for newer version and offer update" flow

**Version metadata recorded**:

- Global lock: `~/.agents/.skill-lock.json` (or `$XDG_STATE_HOME/skills/.skill-lock.json`), schema v3. Per skill: `source` (owner/repo), `sourceType`, `sourceUrl`, `ref`, `skillPath`, `skillFolderHash` (GitHub tree SHA of the skill folder), `installedAt`, `updatedAt` ([src/skill-lock.ts lines 15-75](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/skill-lock.ts)).
- Project lock: `./skills-lock.json` (designed to be checked into VCS, timestamp-free to avoid merge conflicts). Per skill: `source`, `sourceUrl`, `ref`, `sourceType`, `skillPath`, `computedHash` (SHA-256 of file contents on disk) ([src/local-lock.ts lines 5-60](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/local-lock.ts)).
- There is no semver anywhere: "newer version" means "the skill folder's hash at the checked ref differs from the recorded hash".

**List**: `skills list` / `skills ls`, with `-g` for global scope and `--json` for machine-readable output containing `name`, `path`, `scope`, `agents`, `source`, `sourceUrl`, `sourceType` ([src/list.ts lines 113-129](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/list.ts)). Note the JSON does not include `ref` or the hashes; read the lock files directly if those are needed.

**Uninstall**: `skills remove [skills]` (alias `rm`) with `-g`, `-a <agents>`, `-s <skills>`, `-y`, `--all` (per `--help`).

**Non-interactive / TTY behavior** (the whole flow is agent-drivable):

- `add <source> -y`: no prompts. Additionally the CLI detects when it runs inside an AI agent (via `@vercel/detect-agent`, mapping `claude`/`cowork` to claude-code, plus codex, cursor, gemini, opencode) and switches to non-interactive defaults automatically, printing "Agent detected, installing non-interactively" ([src/detect-agent.ts](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/detect-agent.ts), [src/add.ts lines 1091-1099](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/add.ts)).
- `update -y` (or any run with stdin not a TTY): skips the scope prompt and auto-detects scope (project if project skills exist in cwd, else global) ([src/update.ts lines 104-152](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/update.ts), `resolveUpdateScope`, line 121: `if (options.yes || !process.stdin.isTTY)`). The "remove locally deleted skills?" prompt is also skipped in non-interactive mode (lines 259-264).
- `remove -y`: no prompts.
- Only the bare interactive commands (`find`, `remove` with no args, `update` without `-y` on a TTY) prompt; every prompt has a flag or non-TTY fallback.
- Exit codes: `update` sets exit code 1 if any skill failed to update (update.ts lines 979-982), and `add` exits non-zero on failure, which our bootstrap already checks.

**What this means for git-agents**:

- A "check for newer version and offer update" flow can be exactly: `npx -y skills update git-agents -y` (optionally `-g`), or equivalently re-run our existing bootstrap command, since `add` overwrites cleanly.
- To pin, change the bootstrap source to `floklein/git-agents#<tag>`; the pin survives into the lock file and scoped updates.
- Skills installed from a plain git URL (sourceType `git`, as opposed to the GitHub shorthand which yields sourceType `github`) are skipped by the global update check with reason "Git URL" (`getSkipReason`, update.ts lines 168-185); our `floklein/git-agents` shorthand parses as type `github`, so it is fully update-checkable.
