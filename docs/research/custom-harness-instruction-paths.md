# Custom harness instruction paths: survey and prior art

Research for [#49](https://github.com/floklein/git-agents/issues/49), part of the map [#48](https://github.com/floklein/git-agents/issues/48). Researched on 2026-11-17 against official documentation and published source code. Source links point at the commit that was read. This document reports facts and what they imply. It does not design the declaration.

## Question

Is "one plain-Markdown instructions file at a fixed home-relative path, plus optional extra home-relative sync paths" expressive enough to describe real harnesses beyond the built-in five, with Windows first-class?

## Short answer

Mostly yes, with four measured gaps.

- Of the 14 harnesses surveyed, 11 have a global instructions file (or a directory that accepts one) at a home-relative path that is the same on Windows, macOS and Linux by default, as far as their docs or source show.
- 2 (Goose, Devin CLI) put the file under `%APPDATA%` on Windows and under `~/.config` elsewhere. The Windows location is still inside the home directory by default, but it is a different relative path, so one path field cannot describe both.
- 1 (Aider) loads no global instructions file on its own.
- 7 let an environment variable move the file, so a fixed path is right only while that variable is unset.
- 3 (Kiro, Cline, Roo Code) take a directory of rule files instead of one file. In each of them a Markdown file placed in that directory is read.
- Several harnesses read more than one global file, including files owned by other harnesses (`~/.agents/AGENTS.md`, `~/.config/AGENTS.md`, `~/.claude/CLAUDE.md`).

None of the three comparable tools (skills CLI, rulesync, ruler) lets a user add a target that is not built in. All three keep a closed registry in code and express per-OS differences as code branches, not data.

## Part 1: where harnesses keep global instructions

### Summary table

"Same path" means the default location is the same home-relative path on Windows, macOS and Linux.

| Harness | Global instructions, macOS and Linux | Windows | Same path | Moved by | Format | Shape |
| --- | --- | --- | --- | --- | --- | --- |
| dsh (DeepSeek Harness) | `~/.dsh/AGENTS.md` | `%USERPROFILE%\.dsh\AGENTS.md` | Yes | `DSH_HOME` | Markdown | One file. Also reads `~/.agents/AGENTS.md` |
| Amp | `$HOME/.config/amp/AGENTS.md`, `$HOME/.config/AGENTS.md` | Docs give the `$HOME` form only | Yes, as documented | None documented | Markdown, `@file` mentions | One file (two candidates). Also a server-side "Global AGENTS.md" in web settings |
| Goose | `~/.config/goose/.goosehints`, `~/.config/goose/AGENTS.md` | `%APPDATA%\Block\goose\config\.goosehints` and `AGENTS.md` there | No | `GOOSE_PATH_ROOT`, `XDG_CONFIG_HOME`; `CONTEXT_FILE_NAMES` changes the file names | Natural-language text, `@file` imports | One file per configured name. Also reads `~/.agents/AGENTS.md` |
| Aider | None loaded automatically | None | n/a | `read:` in `~/.aider.conf.yml` names any file | n/a | No global instructions file |
| Windsurf (docs now under Devin Desktop) | `~/.devin/global_rules.md`, `~/.devin/rules/*.md` | Not given per OS | Yes, as documented | None documented | Markdown; `rules/*.md` take `trigger` frontmatter | One file plus a directory |
| Devin CLI | `~/.config/devin/AGENTS.md` | `%APPDATA%\devin\AGENTS.md` | No | None documented | Markdown | One file. Also reads `~/.claude/CLAUDE.md` |
| GitHub Copilot CLI | `$HOME/.copilot/copilot-instructions.md`, `$HOME/.copilot/instructions/**/*.instructions.md` | Docs give the `$HOME` form only | Yes, as documented | `COPILOT_HOME`; `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` adds directories | Markdown; modular files need `applyTo` frontmatter | One file plus a directory |
| Kiro | `~/.kiro/steering/` (Markdown files, and `AGENTS.md` inside it) | Not given per OS | Yes, as documented | None documented | Markdown; optional YAML front matter | Directory |
| Crush | `~/.config/crush/CRUSH.md`, `~/.config/AGENTS.md` | `%USERPROFILE%\.config\crush\CRUSH.md` | Yes | `XDG_CONFIG_HOME`, `CRUSH_GLOBAL_CONFIG`, `options.global_context_paths` | Markdown | One file (two candidates) |
| Qwen Code | `~/.qwen/QWEN.md` | `%USERPROFILE%\.qwen\QWEN.md` | Yes | `QWEN_HOME`; `context.fileName` renames the file | Markdown | One file |
| Factory Droid | `AGENTS.md` in `~/.factory/` (also `~/.agents/`, `~/.agent/`) | Docs give the `~` form only | Yes, as documented | None documented | Markdown | One file |
| Kilo Code | `~/.config/kilo/AGENTS.md`; plus files listed under `instructions` in `~/.config/kilo/kilo.jsonc` | `%USERPROFILE%\.config\kilo\AGENTS.md` | Yes | `KILO_CONFIG_DIR`, `XDG_CONFIG_HOME` | Markdown | One file plus a config-declared list. Also reads `~/.claude/CLAUDE.md` |
| Cline | `~/.cline/rules/` (also `~/Documents/Cline/Rules`, `~/Cline/Rules`) | `~/.cline/rules/`; `Documents\Cline\Rules`, including OneDrive Documents | Yes for `~/.cline/rules/` | `CLINE_DIR` | Markdown files | Directory. Also reads `~/.agents/AGENTS.md` |
| Roo Code | `~/.roo/rules/` (read recursively) | `%USERPROFILE%\.roo\rules\` | Yes | Nothing: "fixed and cannot be customized" | Files, `.md` in the examples | Directory, plus a settings-UI field |

### Notes per harness

**dsh (DeepSeek Harness).** A public harness named `dsh` exists: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). Its instructions plugin loads a user-global chain, "`$DSH_HOME/AGENTS.md`, then `<agentsHome>/AGENTS.md`", and "the plugin resolves `$DSH_HOME`, or `~/.dsh`" ([agent-instructions README](https://github.com/deepseek-ai/deepseek-harness/blob/ca33fd6843b205e279c7ccb6cb73a472c78f5760/packages/context/agent-instructions/README.md)). The default home is `join(homedir(), '.dsh')` on every OS, and the shared root is `$DSH_AGENTS_HOME` or `~/.agents` ([home-paths source](https://github.com/deepseek-ai/deepseek-harness/blob/ca33fd6843b205e279c7ccb6cb73a472c78f5760/packages/util/home-paths/src/index.ts)). Two files that match after trimming render once; files that differ both load. This is the harness named in the origin request, and it fits the simple shape while `DSH_HOME` is unset.

**Amp.** User-level guidance is `$HOME/.config/amp/AGENTS.md` and `$HOME/.config/AGENTS.md`, both "always included if they exist". System-wide files are per OS: `/etc/ampcode/AGENTS.md`, `/Library/Application Support/ampcode/AGENTS.md`, `%ProgramData%\ampcode\AGENTS.md`. Personal guidance can also be stored in the web app under Settings, Instructions, "Global AGENTS.md", which is not a local file ([AGENTS.md docs](https://ampcode.com/docs/customize/agents-md)). The settings docs give the Windows user location as `%USERPROFILE%\.config\amp\settings.json`, the same home-relative path as macOS and Linux ([configuration docs](https://ampcode.com/docs/cli/settings)). Neither page says whether `XDG_CONFIG_HOME` moves the user-level `AGENTS.md`.

**Goose.** Global hints are read from the Goose config directory for each configured file name, plus `~/.agents/AGENTS.md` when `AGENTS.md` is one of the names ([load_hints.rs](https://github.com/aaif-goose/goose/blob/ae3e8df434408823c77b4275b78563953e955a0d/crates/goose/src/hints/load_hints.rs)). The default names are `AGENTS.md` and `.goosehints`, and `CONTEXT_FILE_NAMES` replaces them ([using-goosehints docs](https://github.com/aaif-goose/goose/blob/ae3e8df434408823c77b4275b78563953e955a0d/documentation/docs/guides/context-engineering/using-goosehints.md)). The config directory comes from `etcetera::choose_app_strategy` with author `Block` and app `goose`, unless `GOOSE_PATH_ROOT` is set to an absolute path, in which case it is `<root>/config` ([paths.rs](https://github.com/aaif-goose/goose/blob/ae3e8df434408823c77b4275b78563953e955a0d/crates/goose/src/config/paths.rs)). That strategy is XDG on macOS and Linux (`$XDG_CONFIG_HOME` or `~/.config`) and the Windows convention on Windows (`~\AppData\Roaming\<author>\<app>\config`) ([etcetera README](https://github.com/lunacookies/etcetera/blob/6afff5c7f2aa28784dc134e28d38a37df9f516c2/README.md)). The Goose docs confirm the split for the config file: "macOS/Linux: `~/.config/goose/config.yaml`", "Windows: `%APPDATA%\Block\goose\config\config.yaml`" ([config-files docs](https://github.com/aaif-goose/goose/blob/ae3e8df434408823c77b4275b78563953e955a0d/documentation/docs/guides/config-files.md)). The hints page itself only says `~/.config/goose/.goosehints`; the Windows hints path above is derived from the source. `.goosehints` "supports natural language" and has no `.md` extension.

**Aider.** No conventions file is loaded automatically. The docs say to load one with `/read CONVENTIONS.md` or `aider --read CONVENTIONS.md`, or to set `read: CONVENTIONS.md` in `.aider.conf.yml` ([conventions docs](https://aider.chat/docs/usage/conventions.html)). That config file is looked up in "Your home directory", "The root of your git repo" and "The current directory", loaded in that order ([config docs](https://aider.chat/docs/config/aider_conf.html)). A global instructions file for Aider therefore exists only if `~/.aider.conf.yml` names one.

**Windsurf.** `docs.windsurf.com` now redirects to the Devin Desktop docs. The live rules page says: "Place the same files in your home directory (`~/.devin/rules/*.md`, `~/.devin/global_rules.md`) to apply them to every project", and that legacy `.windsurf/rules/*.md`, `.windsurf/global_rules.md` and `.windsurfrules` "are imported by default" ([Desktop rules docs](https://docs.devin.ai/desktop/cascade/memories)). `AGENTS.md` is described for the workspace only. The older Windsurf location `~/.codeium/windsurf/memories/global_rules.md` is not on the live page; see "Not verified".

**Devin CLI.** Included because the Windsurf docs now point at it and because it is a documented per-OS case. Global rules are an `AGENTS.md` in the user config directory: `~/.config/devin/AGENTS.md` on Linux and macOS, `%APPDATA%\devin\AGENTS.md` on Windows. "If you use Claude Code, Devin CLI also reads `~/.claude/CLAUDE.md` as a global rule" ([Devin CLI rules docs](https://docs.devin.ai/cli/extensibility/rules)).

**GitHub Copilot CLI.** `$HOME/.copilot/copilot-instructions.md` holds "User-level instructions that apply across repositories", and `$HOME/.copilot/instructions/**/*.instructions.md` holds modular ones. "If you set the `COPILOT_HOME` environment variable, Copilot CLI uses that directory instead of `$HOME/.copilot` for both user-level instruction locations." Directories in `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` add more `AGENTS.md` and `*.instructions.md` files ([custom instructions docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)). The page gives no Windows form of `$HOME`, and no source was read to check it.

**Kiro.** "Global steering files reside in your home directory under `~/.kiro/steering/`, and apply to all workspaces." Steering files are Markdown with optional YAML front matter for the inclusion mode, which "must be the first content in the file". "You can add AGENTS.md files to the global steering file location (`~/.kiro/steering/`), or to the root folder of your workspace"; they "do not support inclusion modes and are always included" ([steering docs](https://kiro.dev/docs/steering/)). The Kiro CLI steering page redirects to the same page.

**Crush.** The defaults are `<dir of global config>/CRUSH.md` and `AGENTS.md` one level up, where the global config is `$CRUSH_GLOBAL_CONFIG/crush.json` or `<config home>/crush/crush.json` ([load.go](https://github.com/charmbracelet/crush/blob/42d8fb5cbf42bc8b0e87cf703a79411fc9ea82b4/internal/config/load.go)). The config home is `$XDG_CONFIG_HOME` or `<home>/.config` on every OS ([home.go](https://github.com/charmbracelet/crush/blob/42d8fb5cbf42bc8b0e87cf703a79411fc9ea82b4/internal/home/home.go)). The README documents `~/.config/crush/CRUSH.md` and `~/.config/AGENTS.md`, and gives `%USERPROFILE%\.config\crush\` as the Windows config location ([README](https://github.com/charmbracelet/crush/blob/42d8fb5cbf42bc8b0e87cf703a79411fc9ea82b4/README.md)). The `global_context_paths` option replaces the defaults ([config.go](https://github.com/charmbracelet/crush/blob/42d8fb5cbf42bc8b0e87cf703a79411fc9ea82b4/internal/config/config.go)). Crush's global skills are per OS: `~/.config/crush/skills/` on Unix and also `%LOCALAPPDATA%\crush\skills\` on Windows (README).

**Qwen Code.** `~/.qwen/QWEN.md` applies to "You, across all your projects" ([memory docs](https://github.com/QwenLM/qwen-code/blob/a5553cffc40c36d54a00c3a12b79c673b8a7d0bf/docs/users/features/memory.md)). The global directory is `$QWEN_HOME` or `path.join(os.homedir(), '.qwen')` on every OS ([storage.ts](https://github.com/QwenLM/qwen-code/blob/a5553cffc40c36d54a00c3a12b79c673b8a7d0bf/packages/core/src/config/storage.ts)). The `context.fileName` setting changes the file name ([settings docs](https://github.com/QwenLM/qwen-code/blob/a5553cffc40c36d54a00c3a12b79c673b8a7d0bf/docs/users/configuration/settings.md)).

**Factory Droid.** "Droid also checks personal instruction directories in your home folder": `~/.factory/`, `~/.agents/`, `~/.agent/`, for `AGENTS.md` and compatible names ([AGENTS.md docs](https://docs.factory.ai/cli/configuration/agents-md)). The page states no Windows form and no environment variable.

**Kilo Code.** The loader reads `AGENTS.md` from `KILO_CONFIG_DIR` when set, then from the global config directory, then `~/.claude/CLAUDE.md` unless Claude prompts are disabled ([instruction.ts](https://github.com/Kilo-Org/kilocode/blob/dbfbeb443b480a936b8259c1bb7e20e7152dd17b/packages/opencode/src/session/instruction.ts)). The global config directory is `<xdgConfig>/kilo` ([global.ts](https://github.com/Kilo-Org/kilocode/blob/dbfbeb443b480a936b8259c1bb7e20e7152dd17b/packages/core/src/global.ts)), and `xdg-basedir` resolves `xdgConfig` as `XDG_CONFIG_HOME` or `<homedir>/.config` with no Windows branch ([xdg-basedir](https://github.com/sindresorhus/xdg-basedir/blob/4c068bce91132119b8590627ee51b70790551b80/index.js)). The docs describe global rules differently: "configured via the `instructions` key in your global `kilo.jsonc` config file (typically at `~/.config/kilo/kilo.jsonc`)" ([custom rules docs](https://kilo.ai/docs/customize/custom-rules)). Legacy global rule directories `~/.kilo/rules/` and `~/.kilocode/rules/` are still read ([rules-migrator.ts](https://github.com/Kilo-Org/kilocode/blob/dbfbeb443b480a936b8259c1bb7e20e7152dd17b/packages/opencode/src/kilocode/rules-migrator.ts)).

**Cline.** Global rules are a directory of Markdown files. The docs list `Documents\Cline\Rules` (Windows) and `~/Documents/Cline/Rules` (macOS, Linux), and add: "Cline also searches `~/.cline/rules` and `~/Cline/Rules` for global rules. On Windows, it checks `Documents\Cline\Rules` under the OneDrive directories". "Cline also reads cross-tool global AGENTS instructions from `~/.agents/AGENTS.md`" ([rules docs](https://docs.cline.bot/features/cline-rules)). The config layout page puts global rules at `~/.cline/rules/` and says `CLINE_DIR` "replaces `~/.cline/`" ([config docs](https://docs.cline.bot/getting-started/config)).

**Roo Code.** Global rules are directories: `~/.roo/rules/` and `~/.roo/rules-{modeSlug}/` on Linux and macOS, `%USERPROFILE%\.roo\rules\` on Windows, "read recursively, including all files in subdirectories". "The global rules directory location is fixed and cannot be customized." Global custom instructions can also be typed into the Prompts tab ("Custom Instructions for All Modes"), which is not a file. `AGENTS.md` is workspace-only ([custom instructions docs](https://roocodeinc.github.io/Roo-Code/features/custom-instructions), the target of the `docs.roocode.com` redirect).

### What the survey shows

1. **Dot-directories under the home directory are the norm on Windows too.** The Windows location could be established from docs or source for 9 harnesses. 7 of them use the same relative path under `%USERPROFILE%` as on macOS and Linux (dsh, Amp settings, Crush, Qwen Code, Kilo Code, Cline, Roo Code). Tools built on `xdg-basedir` or their own XDG helper get `<home>\.config\...` on Windows, not `%APPDATA%`.
2. **`%APPDATA%` appears in two.** Goose and Devin CLI use it on Windows. The default value of `%APPDATA%` is `%USERPROFILE%\AppData\Roaming` ([KNOWNFOLDERID, Microsoft](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid)), so both files are inside the home directory by default, at `AppData\Roaming\Block\goose\config\` and `AppData\Roaming\devin\`. Zed, outside the survey set, is a third case: `~/.config/zed/AGENTS.md`, and "On Windows, the equivalent file is under `%APPDATA%\Zed\AGENTS.md`" ([Zed docs](https://zed.dev/docs/ai/instructions)).
3. **Environment variables move the file in 7 of 14.** `DSH_HOME`, `GOOSE_PATH_ROOT`, `CRUSH_GLOBAL_CONFIG`, `QWEN_HOME`, `KILO_CONFIG_DIR`, `COPILOT_HOME`, `CLINE_DIR`. `XDG_CONFIG_HOME` also moves Goose (macOS, Linux), Crush and Kilo Code. Settings can rename or replace the file in Goose (`CONTEXT_FILE_NAMES`), Crush (`global_context_paths`) and Qwen Code (`context.fileName`).
4. **The content is Markdown or free text everywhere.** No surveyed harness needs a non-text format for global instructions. Front matter is optional or absent on the always-loaded file in every case; it is required only on modular files (Copilot `*.instructions.md`) and used for inclusion modes (Kiro steering files, Devin `rules/*.md`).
5. **Many harnesses read several global files, some shared.** `~/.agents/AGENTS.md` is read by dsh, Goose and Cline, and `~/.agents/` by Factory Droid. `~/.config/AGENTS.md` is read by Amp and Crush. `~/.claude/CLAUDE.md`, which git-agents already generates, is read by Kilo Code and Devin CLI.

## Part 2: how comparable tools model a target

### skills CLI (vercel-labs/skills)

Read at commit [`57217cf`](https://github.com/vercel-labs/skills/tree/57217cf86ba38148a57af9e90d14a4c049558330).

- **Representation.** One object per agent in `agents: Record<AgentType, AgentConfig>` ([src/agents.ts](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/agents.ts)). `AgentType` is a closed string union. `AgentConfig` has `name`, `displayName`, `skillsDir` (project-relative), `globalSkillsDir` (absolute, or `undefined` when the agent has no global install), `detectInstalled` (a function), and four optional flags ([src/types.ts](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/types.ts)). It models skills directories only; it has no notion of an instructions file.
- **Per-OS and relocatable paths.** Expressed as code at module load, not as data. Most entries are `join(home, '.x/skills')`. XDG agents use `configHome = xdgConfig ?? join(home, '.config')`. Environment overrides are read inline: `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `VIBE_HOME`, `HERMES_HOME` and others. One agent branches on the platform: Reasonix uses `%APPDATA%\reasonix` on `win32` and `~/.reasonix` elsewhere.
- **User-added targets.** Not supported. `--agent` values are checked against `Object.keys(agents)` and an unknown id fails with `SKILLS_INVALID_AGENTS` ([src/add.ts](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/add.ts)). The programmatic `config.agents` (`include`, `exclude`, `default`) "limits targets; a call can narrow it but never widen it" ([docs/api.md](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/docs/api.md)). Adding an agent means editing `src/agents.ts` and running two scripts ([AGENTS.md](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/AGENTS.md)). The fallback for an unlisted agent is the built-in `universal` target, which writes to `.agents/skills`.

### rulesync (dyoshikawa/rulesync)

Read at commit [`bf0281d`](https://github.com/dyoshikawa/rulesync/tree/bf0281d2e7ed460c56b5b1059325785bd2b48d93).

- **Representation.** A target is a string id from a closed tuple per feature; `ToolTargetSchema` is `z.enum(ALL_TOOL_TARGETS)` ([tool-targets.ts](https://github.com/dyoshikawa/rulesync/blob/bf0281d2e7ed460c56b5b1059325785bd2b48d93/src/types/tool-targets.ts)). For rules, each id maps to a class plus a `meta` record: `extension`, `supportsGlobal`, `ruleDiscoveryMode`, `collisionPolicy`, and optional local-file settings ([tool-rule-factories.ts](https://github.com/dyoshikawa/rulesync/blob/bf0281d2e7ed460c56b5b1059325785bd2b48d93/src/features/rules/tool-rule-factories.ts)). The class method `getSettablePaths({ global })` returns `root: { relativeDirPath, relativeFilePath }`, with optional `alternativeRoots` and a `nonRoot` directory ([tool-rule.ts](https://github.com/dyoshikawa/rulesync/blob/bf0281d2e7ed460c56b5b1059325785bd2b48d93/src/features/rules/tool-rule.ts)). In global mode those paths are relative to the home directory ([global mode docs](https://github.com/dyoshikawa/rulesync/blob/bf0281d2e7ed460c56b5b1059325785bd2b48d93/docs/guide/global-mode.md)).
- **Per-OS paths.** Code branches that still return a home-relative path. Zed is the example: `getZedGlobalDir()` returns `AppData/Roaming/Zed` when `process.platform === "win32"` and `.config/zed` otherwise ([zed-paths.ts](https://github.com/dyoshikawa/rulesync/blob/bf0281d2e7ed460c56b5b1059325785bd2b48d93/src/constants/zed-paths.ts)). Goose has no such branch: its global directory is `.config/goose` on every OS ([goose-paths.ts](https://github.com/dyoshikawa/rulesync/blob/bf0281d2e7ed460c56b5b1059325785bd2b48d93/src/constants/goose-paths.ts)), which does not match where Goose reads on Windows.
- **Relocatable paths.** Honored for three tools only: `HERMES_HOME`, `KIMI_CODE_HOME`, `DEEPAGENTS_HOME` ([CLI docs](https://github.com/dyoshikawa/rulesync/blob/bf0281d2e7ed460c56b5b1059325785bd2b48d93/docs/reference/cli-commands.md)). For dsh, "rulesync writes only the default location" ([dsh-paths.ts](https://github.com/dyoshikawa/rulesync/blob/bf0281d2e7ed460c56b5b1059325785bd2b48d93/src/constants/dsh-paths.ts)).
- **User-added targets.** Not supported. An unknown key in `targets` throws `Unknown target '<key>'. Valid targets: ...` ([config.ts](https://github.com/dyoshikawa/rulesync/blob/bf0281d2e7ed460c56b5b1059325785bd2b48d93/src/config/config.ts)). New tools arrive as code: a paths module, a rule class, and a factory entry. `dsh` is one of them, writing `~/.dsh/AGENTS.md` in global mode ([dsh-rule.ts](https://github.com/dyoshikawa/rulesync/blob/bf0281d2e7ed460c56b5b1059325785bd2b48d93/src/features/rules/dsh-rule.ts)).

### ruler (intellectronica/ruler)

Read at commit [`b905f19`](https://github.com/intellectronica/ruler/tree/b905f192d84e340d6c9723ff8eadfa6dbc9be8b6).

- **Representation.** A target is a class implementing `IAgent`: `getIdentifier()`, `getName()`, `getDefaultOutputPath(projectRoot)`, `applyRulerConfig(...)`, and optional capability methods for MCP, skills and subagents ([IAgent.ts](https://github.com/intellectronica/ruler/blob/b905f192d84e340d6c9723ff8eadfa6dbc9be8b6/src/agents/IAgent.ts)). The registry is the `allAgents` array of instances ([agents/index.ts](https://github.com/intellectronica/ruler/blob/b905f192d84e340d6c9723ff8eadfa6dbc9be8b6/src/agents/index.ts)).
- **Paths.** Project-relative only. Every output path is resolved against the project root and rejected if it falls outside it ("Configured output path is outside the project root") ([ConfigLoader.ts](https://github.com/intellectronica/ruler/blob/b905f192d84e340d6c9723ff8eadfa6dbc9be8b6/src/core/ConfigLoader.ts)). There is no home-directory output and so no per-OS path handling for instruction files. `$XDG_CONFIG_HOME/ruler` is where ruler finds its own input when a project has no `.ruler/` directory ([README](https://github.com/intellectronica/ruler/blob/b905f192d84e340d6c9723ff8eadfa6dbc9be8b6/README.md)).
- **User-added targets.** Not supported, but a built-in target can be re-pointed. `ruler.toml` accepts `[agents.<id>]` with `enabled`, `output_path`, `output_path_instructions`, `output_path_config`, `mcp` and `mcp_servers`. An id that is not built in fails with "Invalid agent configured" ([agent-selection.ts](https://github.com/intellectronica/ruler/blob/b905f192d84e340d6c9723ff8eadfa6dbc9be8b6/src/core/agent-selection.ts)). The fallback for an unlisted agent is the built-in `agentsmd` pseudo-agent, which writes a root `AGENTS.md`.

### What the prior art shows

- None of the three accepts a target declared by the user. All three validate ids against a list compiled into the tool and extend it by pull request.
- The fields that recur in a built-in definition are: an id, a display name, one path per scope, a format or extension, a flag for whether a global location exists, and (skills CLI) an install-detection check.
- Per-OS differences and environment overrides are written as code branches in all three. None has a data syntax for "this path on Windows, that path elsewhere".
- The nearest thing to user control is ruler's `output_path` override, which changes where a built-in target writes and is confined to the project root.
- rulesync is the only one of the three that writes to the home directory. It models that as a path relative to the home directory, picks a different relative path by platform when needed (Zed), and ignores environment overrides for most tools.

## Not verified

- **Amp.** Whether `XDG_CONFIG_HOME` moves `~/.config/amp/AGENTS.md`. The docs give only the `$HOME` form for the file, and a Windows path only for settings.
- **Windsurf.** The older global rules path `~/.codeium/windsurf/memories/global_rules.md` appears in search-index snippets of the official docs but not on the live page, which was fetched and names `~/.devin/global_rules.md`. Whether current Windsurf builds still read the old path was not confirmed.
- **Goose on Windows.** The hints path `%APPDATA%\Block\goose\config\.goosehints` is derived from the source (`Paths::in_config_dir` plus the documented Windows config directory). The hints documentation does not state it.
- **Kiro, Factory Droid, GitHub Copilot CLI, Devin CLI.** Their docs give `~` or `$HOME` paths without a Windows form (Devin CLI gives one for its config directory only). No source code was read for these four, so the Windows resolution was not checked in code. No relocating environment variable is documented for Kiro, Factory Droid or Devin CLI; none was found, which is not proof that none exists.
- **Aider.** Whether `read:` accepts absolute or home-relative paths is not stated on the pages read.
- **Roo Code.** The docs site now redirects to a GitHub Pages copy. The page was read there; whether the extension is still maintained was not checked.

## Implications for the declaration shape

Stated as facts about the surveyed harnesses, not as a design.

**Fit the simple shape as is** (one Markdown file, one home-relative path, same on all three OSes, default configuration):

- dsh: `.dsh/AGENTS.md`
- Qwen Code: `.qwen/QWEN.md`
- Crush: `.config/crush/CRUSH.md`
- Amp: `.config/amp/AGENTS.md`
- Kilo Code: `.config/kilo/AGENTS.md`
- Factory Droid: `.factory/AGENTS.md`
- GitHub Copilot CLI: `.copilot/copilot-instructions.md`
- Windsurf, per the live docs: `.devin/global_rules.md`

**Fit by naming one file inside a rules directory.** Kiro (`.kiro/steering/AGENTS.md` is always included), Cline (`.cline/rules/<name>.md`) and Roo Code (`.roo/rules/<name>.md`) have no single global file, but each reads Markdown files from its directory, so one fixed file path there is read. The rest of the directory is the kind of thing an extra sync path covers. The file name is the user's choice in Cline and Roo Code, so the declaration cannot be derived from the harness alone.

**Do not fit with a single path: per-OS location.** Goose and Devin CLI (and Zed) read from `AppData\Roaming\...` on Windows and `.config/...` on macOS and Linux. Both spellings are home-relative by default, so the "inside the home directory" check is not what fails. What fails is that one path string cannot be right on both a Windows machine and a non-Windows machine sharing the same repo. This is 2 of 14 surveyed, 3 counting Zed.

**Fit only while an environment variable is unset: relocatable location.** dsh, Goose, Crush, Qwen Code, Kilo Code, GitHub Copilot CLI and Cline each read a variable that moves the global directory, and `XDG_CONFIG_HOME` also moves three of them (Goose, Crush, Kilo Code). The variable is per-machine state. A fixed declared path describes the default; on a machine where the variable is set, the harness reads elsewhere and a file written to the declared path is not loaded. The same is already true of built-in harnesses: the skills CLI reads `CODEX_HOME` and `CLAUDE_CONFIG_DIR`, and git-agents' built-in paths do not. A relocated directory can also sit outside the home directory, which the map puts out of scope.

**Do not fit: no global instructions file.** Aider loads nothing globally unless `~/.aider.conf.yml` contains a `read:` entry. The instructions file can then live at any path, and the YAML file that points to it is a home-relative file. Roo Code's "Custom Instructions for All Modes" and Amp's web "Global AGENTS.md" are settings, not files; both harnesses also have a file-based route.

**Plain Markdown holds, with two details.**

- Goose's default file is `.goosehints`, free text with no `.md` extension. Goose also reads `AGENTS.md` from the same directory by default.
- Where front matter exists it must come first in the file (Kiro: "must be the first content in the file"). A file generated by git-agents begins with the `<!-- ga:begin core ... -->` marker, so it cannot also begin with front matter. No surveyed harness requires front matter on its always-loaded global file.

**One file per harness is an approximation.** Most surveyed harnesses read more than one global file, and some of those files belong to other harnesses.

- Kilo Code and Devin CLI read `~/.claude/CLAUDE.md`, which git-agents generates for Claude Code. A custom harness declared for either one would load the canonical core twice, once from its own file and once from Claude's.
- `~/.agents/AGENTS.md` (dsh, Goose, Cline, Factory Droid) and `~/.config/AGENTS.md` (Amp, Crush) are shared by several harnesses. Two custom harnesses could name the same file, and one declaration there would feed several harnesses.
- dsh drops a duplicate only when two files match after trimming, so two generated files with different overlays both load.

**Extra sync paths follow the instructions file.** For the harnesses that fit, the skills CLI registry records the neighboring global skills directory as a plain home-relative path with no platform branch. For the per-OS harnesses they move with it, and Crush adds a Windows-only skills location under `%LOCALAPPDATA%`. A per-OS need therefore applies to sync paths as well as to the instructions file.

**Prior art offers no precedent for a user-declared target.** No field vocabulary exists to stay compatible with. The built-in definitions in all three tools carry an id, a display name and a path per scope; rulesync adds a format extension and a global-support flag. Where a tool handles a per-OS home path at all (rulesync for Zed), it selects between two home-relative paths by platform.

**Windows first-class.** Every harness that fits the simple shape resolves to a dot-directory under `%USERPROFILE%` on Windows, with the same relative path as on macOS and Linux. No surveyed harness needs a drive letter, a registry value or a path outside the user profile by default. The Windows-specific cases are exactly the `%APPDATA%` ones above, plus Cline's `Documents\Cline\Rules`, which can sit under a OneDrive folder and which Cline treats as a compatibility location next to `~/.cline/rules`.
