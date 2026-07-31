# Global instruction files across the five harnesses

Research for issue #6 (part of map #4). Facts only, no recommendations; the canonical-model decision is a separate ticket. Researched 2026-07-31 against current official docs, official GitHub repos, and issue trackers. Paths written `~/...` resolve to `%USERPROFILE%\...` on Windows unless noted.

## Summary table

| Harness | Global instructions file | AGENTS.md native? | Follows symlinks for instruction files? |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` (+ `~/.claude/rules/`) | No ("Claude Code reads CLAUDE.md, not AGENTS.md") | Yes for CLAUDE.md, rules, skills (documented); known bugs for symlinked `.claude` dir and commands |
| Codex | `~/.codex/AGENTS.md` (or `AGENTS.override.md`) | Yes, AGENTS.md is its native format | Not documented for AGENTS.md; documented yes for skills (recent) |
| Cursor | No global instructions file documented (User Rules live in app settings); `AGENTS.md`/`CLAUDE.md` read at project root only | Yes (project root and nested) | Not documented; recurring forum bug reports that symlinked rule dirs are not loaded |
| Gemini CLI | `~/.gemini/GEMINI.md` (filename configurable) | Via config only (`context.fileName`), not by default; default-change request closed as not planned | No for GEMINI.md (open bug); no for skills and commands dirs (open issues) |
| OpenCode | `~/.config/opencode/AGENTS.md` (falls back to `~/.claude/CLAUDE.md`) | Yes, AGENTS.md is its native format | Symlinked directories not traversed (open issues); file-level behavior not documented |

## Claude Code

Source: https://code.claude.com/docs/en/memory (all claims in this section unless noted).

### Files and precedence

Load order, broadest to most specific; all discovered files are concatenated, not overriding:

1. Managed policy: macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`, Linux/WSL `/etc/claude-code/CLAUDE.md`, Windows `C:\Program Files\ClaudeCode\CLAUDE.md`. Can also be inlined via the `claudeMd` key in `managed-settings.json`. Cannot be excluded.
2. User: `~/.claude/CLAUDE.md`.
3. Project: `./CLAUDE.md` or `./.claude/CLAUDE.md`, plus every `CLAUDE.md`/`CLAUDE.local.md` in ancestor directories (walked up from cwd, ordered root-down so closer files are read last).
4. Local: `./CLAUDE.local.md`, appended after `CLAUDE.md` at the same level.

Subdirectory CLAUDE.md files load on demand when Claude reads files there. `@path/to/import` syntax expands imports at launch (relative to the importing file, max depth 4 hops); imports resolving outside the working directory trigger a one-time approval dialog, except in user-scope files. `claudeMdExcludes` (glob patterns) can skip files.

`~/.claude/rules/` is a documented user-level rules directory; user rules load before project `.claude/rules/`, so project rules win. Rules without `paths:` frontmatter load at launch with the same priority as `.claude/CLAUDE.md`.

### AGENTS.md adoption

The docs state plainly: "Claude Code reads `CLAUDE.md`, not `AGENTS.md`." Official bridges: a CLAUDE.md containing `@AGENTS.md` (recommended on Windows), or `ln -s AGENTS.md CLAUDE.md`. With `CLAUDE_CODE_NEW_INIT=1`, `/init` also reads AGENTS.md, Cursor, Copilot, Windsurf, and Cline rule files when generating CLAUDE.md. The official changelog (https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md, v2.1.220 at research time) has no entry adding native AGENTS.md reading, and Claude Code is absent from the adopter list at https://agents.md.

### Symlink behavior

- Documented supported: reading a symlinked CLAUDE.md (`ln -s AGENTS.md CLAUDE.md` appears in the docs), with the caveat "On Windows, creating a symlink requires Administrator privileges or Developer Mode, so use the `@AGENTS.md` import instead."
- Documented supported: `.claude/rules/` ("Symlinks are resolved and loaded normally, and circular symlinks are detected and handled gracefully") and skills dirs ("Claude Code follows the symlink", https://code.claude.com/docs/en/skills).
- Known issues (issue tracker, not docs): writes through a symlinked CLAUDE.md are refused (anthropics/claude-code#66559); a symlinked `.claude` directory breaks command and skill discovery (#10522, #36659); symlinked files in `.claude/commands/` are dropped from autocomplete (#55791); launching from a symlinked directory resolves to the real path before ancestor lookup (#17732).

### User-level asset directories

All documented: `~/.claude/agents/` (subagents, https://code.claude.com/docs/en/sub-agents), `~/.claude/skills/<name>/SKILL.md`, `~/.claude/commands/` (still works, but "custom commands have been merged into skills"; same-name skill wins, https://code.claude.com/docs/en/skills), `~/.claude/rules/`.

## Codex (OpenAI Codex CLI)

Source: https://developers.openai.com/codex/guides/agents-md (currently 308-redirects to learn.chatgpt.com/docs/agent-configuration/agents-md; same content).

### Files and precedence

- Global: in the Codex home dir ("defaults to `~/.codex`, unless you set `CODEX_HOME`"), Codex reads `AGENTS.override.md` if present, otherwise `AGENTS.md`. Global loads first.
- Project: starting at the project root (typically the Git root), Codex walks down to the cwd; in each directory it takes at most one file, checking `AGENTS.override.md`, then `AGENTS.md`, then names from `project_doc_fallback_filenames`. Empty files are skipped.
- Merge: "Codex concatenates files from the root down, joining them with blank lines. Files closer to your current directory override earlier guidance because they appear later in the combined prompt."
- Size cap: `project_doc_max_bytes`, 32 KiB by default; Codex stops adding files at the cap. Truncation is silent (openai/codex#7138, #13386).
- Legacy `~/.codex/instructions.md` and `experimental_instructions_file` no longer appear in current docs; the only documented instruction-related config keys are `project_doc_max_bytes` and `project_doc_fallback_filenames`.

### AGENTS.md adoption

Native and primary; Codex co-created the standard (https://agents.md) and `/init` generates an AGENTS.md.

### Symlink behavior

- AGENTS.md: not documented. Users symlink repo AGENTS.md to `~/.codex/AGENTS.md` as a workaround in openai/codex#8759, suggesting file symlinks are followed in practice, but there is no official statement.
- Skills: documented as supported now: "Codex supports symlinked skill folders and follows the symlink target when scanning these locations" (https://developers.openai.com/codex/skills). This is recent; earlier versions did not follow them (openai/codex#8943, #11314).

### User-level asset directories

- Skills (https://developers.openai.com/codex/skills): repo scope `.agents/skills` scanned from cwd up to the repo root; user scope `$HOME/.agents/skills`; admin scope `/etc/codex/skills`. `~/.codex/skills` is legacy (still honored per community reports, absent from current docs).
- Subagents (https://developers.openai.com/codex/subagents): custom agents are standalone TOML files under `~/.codex/agents/` (personal) or `.codex/agents/` (project). Required fields: `name`, `description`, `developer_instructions`.
- Custom prompts: `~/.codex/prompts/`, top-level Markdown files only, become slash prompts (https://developers.openai.com/codex/custom-prompts). Not currently synced by ga.

## Cursor

Sources: https://cursor.com/docs/context/rules, https://cursor.com/docs/cli/using, https://cursor.com/docs/context/subagents, https://cursor.com/docs/context/commands.

### Files and precedence

- Rules precedence: "Team Rules -> Project Rules -> User Rules. All applicable rules are merged; earlier sources take precedence when guidance conflicts."
- User Rules are global to the Cursor environment but are managed in the app (Customize > Rules), not documented as a file under `~/.cursor`. Team Rules are managed from the Cursor dashboard.
- Project rules: `.cursor/rules/` with `.mdc` files; nested rules and subdirectories supported. The legacy `.cursorrules` file no longer appears anywhere in the current rules docs; treat continued support as undocumented.
- AGENTS.md: "Place it in your project root as an alternative to `.cursor/rules`"; nested AGENTS.md in subdirectories supported.
- Cursor CLI: "The CLI also reads `AGENTS.md` and `CLAUDE.md` at the project root (if present) and applies them as rules alongside `.cursor/rules`." No global instructions file is documented for the CLI; forum threads confirm the gap (https://forum.cursor.com/t/global-rules-with-cursor-cli/132240, https://forum.cursor.com/t/how-to-create-global-rules-for-cli/137916).

### AGENTS.md adoption

Native at project scope (root plus nested); Cursor is listed as an adopter at https://agents.md and its own docs document it as a first-class alternative to `.cursor/rules`.

### Symlink behavior

Not documented officially, and forum bug reports show repeated regressions: symlinks to rules `.mdc` files not followed (https://forum.cursor.com/t/cursor-no-longer-can-follow-symlinks-to-rules-mdc-files/146010), symlinked rules subfolders not followed again (https://forum.cursor.com/t/symlinked-rules-mdc-are-not-followed-again/152918), skills not discovered through symlinks (https://forum.cursor.com/t/cursor-doesnt-follow-symlinks-to-discover-skills/149693), and a symlinked `.cursor` directory breaking hooks (https://forum.cursor.com/t/cursor-hooks-relative-path-fails-when-using-symlinked-cursor-directory/149563). Windows junction behavior is undocumented. Treat symlinks as unreliable for Cursor.

### User-level asset directories

Documented global dirs: `~/.cursor/agents/` (subagents, usable in editor, CLI, and Cloud Agents; Cursor also reads compat dirs `~/.claude/agents/` and `~/.codex/agents/`, with `.cursor/` winning name conflicts, https://cursor.com/docs/agent/subagents) and skills auto-loaded from `.agents/skills/`, `.cursor/skills/`, `~/.agents/skills/`, `~/.cursor/skills/`, plus compat loading from `.claude/skills/`, `.codex/skills/`, `~/.claude/skills/`, and `~/.codex/skills/` (https://cursor.com/docs/skills). Commands: `.cursor/commands/` and `~/.cursor/commands/` existed as a feature (forum bug reports reference the global dir, https://forum.cursor.com/t/commands-are-not-detected-in-the-global-cursor-directory/150967), but the current docs have folded commands into Skills; Cursor 2.4 ships a `/migrate-to-skills` flow that converts eligible rules and commands to skills, and the former commands docs page now documents Skills. A global `~/.cursor/rules/` directory is not documented. CLI config lives at `~/.cursor/cli-config.json` (`%USERPROFILE%\.cursor\cli-config.json` on Windows), overridable via `CURSOR_CONFIG_DIR` (https://cursor.com/docs/cli/reference/configuration).

## Gemini CLI

Sources: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md, .../docs/cli/custom-commands.md, .../docs/core/subagents.md, .../docs/cli/skills.md.

### Files and precedence

Hierarchical loading, all concatenated with origin separators and sent as part of the system prompt:

1. Global: `~/.gemini/GEMINI.md`.
2. Project/ancestors: files from the workspace directories and their parents.
3. Subdirectories: just-in-time context from accessed directories.

The context filename is configurable via `context.fileName` in `settings.json` (user `~/.gemini/settings.json`, workspace `.gemini/settings.json`; workspace overrides user) and accepts a string or an array, for example `"fileName": ["AGENTS.md", "CONTEXT.md", "GEMINI.md"]`. The hard-coded default is GEMINI.md only (`DEFAULT_CONTEXT_FILENAME = 'GEMINI.md'` in `packages/core/src/tools/memoryTool.ts`). Context files support `@file.md` imports (relative and absolute). `/memory show` and `/memory reload` inspect and refresh the combined context. Discovery caps: `context.discoveryMaxDirs` (default 200) and `context.loadMemoryFromIncludeDirectories` (default false), per https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md. Windows paths are written as `%USERPROFILE%\.gemini\...` in the docs.

### AGENTS.md adoption

Supported via configuration only; the default remains `GEMINI.md`. The docs show AGENTS.md explicitly in the `context.fileName` example, and agents.md itself documents Gemini CLI support via that setting. A request to add AGENTS.md to the defaults ("Add AGENTS.md to the context filename list by default", google-gemini/gemini-cli#12345) was closed as not planned (state verified via GitHub API on 2026-07-31). Gemini CLI appears on the agents.md adopter list on the config basis only.

### Symlink behavior

Not followed for key files, per open issues (not documented in docs):

- "GEMINI.md is not read if it's a symlink" (google-gemini/gemini-cli#11547): a symlinked `~/.gemini/GEMINI.md` is ignored; a copied file works. Closed as not planned (state verified via GitHub API on 2026-07-31), so this is intended behavior for now.
- Symlinked commands directory not read (#4906); symlinked skills directories not followed (#16247); `@` operator does not search into symlinked folders (#12565); the CLI sometimes rewrites `~/.gemini/settings.json` and destroys a symlink (#10960).

### User-level asset directories

Documented: `~/.gemini/commands/` (TOML commands; project `.gemini/commands/` wins name conflicts; subdirectories namespace with `:`, https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/custom-commands.md), `~/.gemini/agents/` (Markdown subagents with YAML frontmatter; project `.gemini/agents`; documented in docs/core/subagents.md and announced at https://developers.googleblog.com/subagents-have-arrived-in-gemini-cli/), skills at `~/.gemini/skills/` or the `~/.agents/skills/` alias, with the alias taking precedence within a tier (workspace: `.gemini/skills/` or `.agents/skills/`; precedence tiers built-in, extension, user, workspace; https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md), following the Agent Skills open standard.

## OpenCode

Sources: https://opencode.ai/docs/rules/, https://opencode.ai/docs/config/, https://opencode.ai/docs/agents/, https://opencode.ai/docs/commands/, https://opencode.ai/docs/skills/.

### Files and precedence

Rule file lookup order ("the first matching file wins in each category"):

1. Local files by traversing up from the current directory (`AGENTS.md`, falling back to `CLAUDE.md`).
2. Global file at `~/.config/opencode/AGENTS.md`.
3. Claude Code file at `~/.claude/CLAUDE.md` (compat fallback; disable with `OPENCODE_DISABLE_CLAUDE_CODE=1`, with finer-grained `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` and `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`).

An `instructions` array in `opencode.json` (project or global) adds more files; it supports globs (for example `.cursor/rules/*.md`, `packages/*/AGENTS.md`) and remote URLs (5 second fetch timeout). All instruction files are combined with the AGENTS.md files.

Windows note: the docs specify `~/.config/opencode/` with no Windows-specific alternative, meaning `%USERPROFILE%\.config\opencode` on Windows (not AppData, not XDG-varying per platform); third-party plugin bug reports corroborate that OpenCode uses `~/.config/opencode/` on all platforms including Windows (https://github.com/colbymchenry/codegraph/issues/535). `%ProgramData%\opencode` is documented only for managed system-level config, and `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` env vars can override paths. Config precedence (later overrides earlier, merged): remote `.well-known/opencode`, global `~/.config/opencode/opencode.json`, `OPENCODE_CONFIG` path, project `opencode.json`, `.opencode` directories, `OPENCODE_CONFIG_CONTENT`, managed config (https://opencode.ai/docs/config/).

### AGENTS.md adoption

Native and primary at both project and global scope; OpenCode is listed at https://agents.md.

### Symlink behavior

Not documented. Open issues show symlinked directories are not traversed: file search/`@` mentions miss symlinked dirs because ripgrep is invoked without `--follow` (anomalyco/opencode#29080), and a symlinked `.claude/skills` directory yields no skills (#18848); symlinked agent folders were also reported undetected (sst/opencode#1313). File-level symlinks for AGENTS.md itself are not covered by docs or a definitive issue.

### User-level asset directories

Documented (plural names): `~/.config/opencode/agents/` (project `.opencode/agents/`), `~/.config/opencode/commands/` (project `.opencode/commands/`), skills at `~/.config/opencode/skills/<name>/SKILL.md` plus compat locations `~/.claude/skills/` and `~/.agents/skills/` (project: `.opencode/skills/`, `.claude/skills/`, `.agents/skills/`).

## The AGENTS.md standard

- Stewarded by the Agentic AI Foundation under the Linux Foundation (announced 2025-12-09; co-founded by Anthropic, Block, and OpenAI; anchored by MCP, goose, and AGENTS.md). Sources: https://agents.md, https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation, https://openai.com/index/agentic-ai-foundation/. Repo: https://github.com/agentsmd (github.com/openai/agents.md redirects there).
- Spec scope: plain Markdown at the repo root, no required fields. Nested files supported: "Agents automatically read the nearest file in the directory tree, so the closest one takes precedence."
- The spec says nothing about global or user-level files. Global locations are per-tool territory (Codex `~/.codex/AGENTS.md`, OpenCode `~/.config/opencode/AGENTS.md`; Claude Code, Cursor, and Gemini CLI have no global AGENTS.md).
- Adopter list at https://agents.md (about 24 tools) includes Codex, Cursor, Gemini CLI, and OpenCode; Claude Code is absent.

## Community patterns for one canonical instructions file

1. Symlink AGENTS.md to per-tool names: `mv CLAUDE.md AGENTS.md && ln -s AGENTS.md CLAUDE.md`. Documented by SSW (https://www.ssw.com.au/rules/symlink-agents-to-claude), community write-ups (https://plgah.medium.com/one-agents-md-to-rule-them-all-70e6dc87a05f, https://tessl.io/blog/the-rise-of-agents-md-an-open-standard-and-single-source-of-truth-for-ai-coding-agents/), and even Claude Code's own docs. Windows caveats: file symlinks need Administrator or Developer Mode (`SeCreateSymbolicLinkPrivilege`); Git for Windows defaults `core.symlinks=false`, so checked-out symlinks become plain text files containing the target path (https://gitforwindows.org/symbolic-links.html); NTFS junctions only work for directories, so a file link must be a symlink or hardlink (hardlinks break when editors replace files on save).
2. Generate-and-copy tools (the dominant tooling pattern, avoiding symlink portability problems): ruler (https://github.com/intellectronica/ruler, concatenates `.ruler/` sources into per-agent files for 30+ agents), rulesync (https://github.com/dyoshikawa/rulesync, generates configs for 40+ tools from `.rulesync/`, also imports existing files, covers rules, MCP, commands, subagents, skills), airul (https://github.com/mitkury/airul, generates AGENTS.md/CLAUDE.md from docs). Dotfiles managers handle the home-directory files: GNU Stow (symlink farm) and chezmoi (`symlink_` source-state attribute, https://www.chezmoi.io/reference/source-state-attributes/).
3. Import/include mechanisms as the no-symlink alternative: Claude Code `@AGENTS.md` import (Anthropic's recommended bridge on Windows), Gemini CLI `@file.md` imports plus `context.fileName`, OpenCode `instructions` array with globs and URLs, Codex `project_doc_fallback_filenames` for arbitrarily named docs.
4. Vendor guidance summary: Anthropic documents import-or-symlink bridging to AGENTS.md; Google documents `context.fileName` as the sanctioned opt-in; Cursor and OpenCode document AGENTS.md as first-class; Codex is AGENTS.md-native by design.

## Drift check against src/utils/agentDefs.ts

Sync paths are resolved relative to the home directory (`src/utils/flows.ts`, `getLocalSyncPath`).

| Synced path | Verdict |
| --- | --- |
| `.claude/CLAUDE.md`, `.claude/agents`, `.claude/rules`, `.claude/skills`, `.claude/commands` | All match documented user-level locations. Note commands are being merged into skills (both still work). |
| `.codex/AGENTS.md` | Matches. Caveat: an unsynced `~/.codex/AGENTS.override.md` would silently shadow it, and `CODEX_HOME` can move the whole dir. |
| `.codex/agents` | Matches current subagents docs (personal TOML agents). |
| `.agents/skills` | Matches current Codex user-scope skills location; also read by Cursor and Gemini CLI and OpenCode as a compat/alias location, so this one path serves four harnesses. |
| (not synced) `.codex/prompts` | Gap: documented Codex custom prompts dir is not in the sync list. |
| `.cursor/agents`, `.cursor/skills` | Match documented global locations. |
| `.cursor/commands` | Partially drifted: the global commands dir existed, but current docs have merged commands into Skills (`/migrate-to-skills` in Cursor 2.4), and forum reports say global commands detection is flaky. |
| `.cursor/rules` | Drift: a global `~/.cursor/rules/` directory is not documented as read by the IDE or CLI (User Rules live in app settings; the CLI reads project files only). Forum threads confirm no global rules mechanism for the CLI. Syncing it may be a no-op today. |
| `.gemini/GEMINI.md`, `.gemini/agents`, `.gemini/commands`, `.gemini/skills` | All match documented locations. Caveat: `context.fileName` can rename the context file, and a symlinked `~/.gemini/GEMINI.md` is ignored (bug #11547), so ga's copy-based sync is actually the safe approach here. |
| `.config/opencode/AGENTS.md`, `.config/opencode/agents`, `.config/opencode/commands`, `.config/opencode/skills` | All match documented global locations (plural dir names confirmed). Caveat: the Windows location of `~/.config/opencode` is not explicitly documented, and `OPENCODE_CONFIG_DIR` can move it. |

Cross-cutting observation: ga syncs by copying real files rather than linking, which sidesteps every symlink limitation listed above (Gemini's symlink bug, Cursor's flaky symlinked rules, OpenCode's non-followed symlinked dirs, Windows symlink privileges, and Git for Windows `core.symlinks=false`).
