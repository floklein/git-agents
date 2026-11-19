---
name: git-agents
description: "Sync AI harness files and global instructions across machines and harnesses via git. Subcommands: setup, sync, sync unify, edit, harness, status."
disable-model-invocation: true
---

# git-agents

You orchestrate; deterministic scripts do every file operation. Run them with:

```
npx -y git-agents@latest --internal <command> [--input <json> | --input - | --input-file <path>]
```

Every command prints exactly one JSON envelope: `{"ok":true,"result":...}` or `{"ok":false,"error":{"code":"...","message":"..."}}`. Relay error messages with their remedy; never edit synced files by hand; never write anything except through the gate below.

Input channels: inline `--input <json>` is fine for small payloads; `--input-file <path>` reads the JSON from a file and `--input -` reads it from stdin, so the payload never crosses shell quoting. For any payload carrying multi-line content, backslashes, or backticks (`stage` above all, especially on Windows), write the JSON to a temp file and pass `--input-file`.

The command surface:

| Command | Effect | Writes? |
| --- | --- | --- |
| `status` | Config, canonical version, generated states, drift, caveats | no |
| `setup` | Onboarding: remote choice, repo creation, clone | clone + config |
| `transport-begin` | Mirror local files into the clone, commit, merge from origin; reports clean changes or conflicts | clone |
| `transport-resolve` | Settle conflicted files: contents, a side (a deleted side deletes), or a deletion; the whole batch is checked first | clone |
| `transport-commit` | Complete the merge, mirror the result home, push (`{"deferPush":true}` skips the push) | gated |
| `transport-abort` | Abort the in-progress merge | clone |
| `gather` | Collect drift vs canonical with attribution and input hashes | no |
| `stage` | Accept a proposed canonical, render exact diffs | stage file |
| `harness-stage` | Validate the complete proposed set of custom harness declarations; render the file diff, the paths that start or stop syncing, and a removal's repo cleanup | stage file |
| `harness-apply` | Write the staged declarations file and apply a removal's cleanup in the clone | gated |
| `apply` | Write the staged canonical and regenerate all copies | gated |
| `propagate` | Regenerate harness copies from the current canonical | gated |
| `install-pointer-docs` | Print the Cursor pointer rule with resolved paths | no |
| `version-check` | Compare the installed skill version to the CLI version | no |

## Router

The first word of the arguments selects the subcommand: `setup`, `sync`, `edit`, `harness`, or `status`. When it is `sync`, an optional second word `unify` selects the full convergence flow; any other second word gets a hint listing `sync` and `sync unify`. When it is `edit` or `harness`, everything after the first word is the freeform request. With no argument, or an unknown first word, run the status subcommand and list the surface. Before any subcommand, if `status` reports `clonePresent: false`, run the setup branch first, then offer to continue what was originally asked. After any subcommand completes, run the update check (see below).

## Update check

After the requested subcommand's work is fully done (never before or instead of it), check whether this skill is outdated: read the `VERSION` file next to this SKILL.md, then run `version-check` with `{"skillVersion":"<its contents>"}`. If the result says `updateAvailable: true`, append exactly one line to your closing report: "git-agents <cliVersion> is available (installed: <skillVersion>). Want me to update?" On an explicit yes, run `npx -y skills add floklein/git-agents -y` and confirm the refresh. On a decline, drop the subject; nothing is remembered. If the VERSION file is missing, the command fails, or `updateAvailable` is false, say nothing at all.

## The gate

Before anything is written, show the user the exact script-rendered diffs and get an explicit confirmation. The diffs and the question travel in the **same message**: render the diffs, then ask in plain text directly below them. Never use a structured question tool (multiple-choice UI, option chips, any tool-mediated prompt) for gate confirmation; those render without the diffs in view, and the user must be able to see the diffs at the moment of answering. **No is the default**: anything but a clear yes means stop, and stopping costs nothing. Your own summary is never a substitute for the diffs. Declining a transport merge means `transport-abort`.

## Naming harnesses

The harness set is not fixed: besides the built-ins, the user may declare custom harnesses. Name a custom harness by its declared `name`, or by its id when it has none, and never state how many harnesses or generated files there are. `gather`, `stage`, and the `generated` and `drift` parts of `status` identify a harness by its overlay id only (`claude`, `gemini`, or a custom harness's own id); find a custom harness's `name` in the `status` entry of `harnesses` with that id.

## Subcommands

### status

Run `status`. Report concisely: configured and clone state, canonical version, the custom harnesses by name, each generated file's state (current, stale, modified, untracked, missing, no-canonical), the drift summary, and every caveat with its remedy. When any generated file is `stale` or `untracked` (a newly declared instructions file reads as `untracked` until its first convergence), or drift is present, point at `/git-agents sync unify`. An `invalid-harness-declarations` caveat blocks every sync until the file is fixed: point at `/git-agents harness`.

### setup

1. Run `status`. If configured with a clone present, report that and stop; reconfigure (with `force:true`) only if the user explicitly asks. `force:true` deletes the local clone and re-clones from the remote; it is the recovery path after a rewritten remote history. Local harness files are not affected.
2. Ask the user's remote preference: GitHub CLI auto-create (a private `git-agents-remote` repo) or a custom git remote URL.
3. Run `setup` with `{"remote":"gh"}` or `{"remote":"git","repoUrl":"..."}`. On a typed error (`gh-not-installed`, `gh-not-authenticated`, `invalid-repo-url`, `clone-failed`), relay the message and help fix it before retrying. A forced re-clone refuses with `unpushed-commits` when the clone holds commits on no remote ref: run `transport-abort` first if a transport is in progress, and add `discardLocal:true` only after the user confirms discarding them.
4. Suggest `/git-agents sync unify` as the next step.

### sync

Transport only: configs travel to and from the repo independently; the canonical is never involved. Follow [references/transport-flow.md](references/transport-flow.md).

### sync unify

The full convergence flow: transport, then merge drift into the canonical, regenerate every copy, and push once. Follow [references/unify-flow.md](references/unify-flow.md).

### edit

A freeform request to change the global instructions: add a rule, reword one, remove one. The request text is never pasted verbatim; you interpret it and draft the change into the canonical yourself. With no request text, ask what the user wants changed; their answer is the request.

Run the unify flow ([references/unify-flow.md](references/unify-flow.md)) with one addition to its draft step: besides classifying any drift, fold the requested change into the proposed core and overlays.

- Route it by the same classification rules: content that helps every harness goes to the core; harness-specific content goes to that harness's overlay. A request naming a harness ("for Claude only") pins the overlay.
- Place it in the section where it belongs, matching the canonical's tone, formatting, and heading conventions. Merge it into an existing rule rather than adding a near-duplicate.
- Removals and rewordings edit the existing content in place.
- Ask only when the request is genuinely ambiguous, such as an unclear target or a contradiction with an existing rule; otherwise decide, and let the gate diffs speak.

Everything else is the unify flow unchanged: pre-existing drift is folded in alongside the request, and one stage, one gate, one apply, one push carry both.

### harness

A freeform request to declare, change, or remove a custom harness: one beyond the built-ins, whose paths then sync and whose instructions file converges exactly like a built-in's. You interpret the request and draft the complete set of declarations yourself; the declarations file is never edited by hand. With no request text, list the built-in and custom harnesses and ask what to change; the answer is the request. Follow [references/harness-flow.md](references/harness-flow.md).

## Cursor

Cursor has no global instructions file, so it receives no generated copy; that is a documented limitation, not a bug. If the user works with Cursor, offer the one-time pointer rule: see [references/cursor-pointer.md](references/cursor-pointer.md).
