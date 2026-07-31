import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  runClone,
  runGhCreateRepo,
  runGhPrecheck,
  runGhRepoCheck,
  runGitUrlValidation,
  type FlowDeps,
} from "../utils/flows";
import {
  checkGhAuth,
  checkGhInstalled,
  checkGitRepoExists,
  cloneRepo,
  ghCreateRepo,
  ghGetRepoCloneUrl,
  ghRepoExists,
  gitSetRemoteUrl,
} from "../utils/shell";
import { readConfig, writeConfig } from "../utils/config";
import { InternalCommandError, invalidInputError } from "./errors";
import type { Config } from "../types";
import type { InternalDeps } from "./commands";

export const GH_REPO_NAME = "git-agents-remote";

const SetupInputSchema = z.discriminatedUnion("remote", [
  z.object({ remote: z.literal("gh"), force: z.boolean().optional() }),
  z.object({
    remote: z.literal("git"),
    repoUrl: z.string().min(1),
    force: z.boolean().optional(),
  }),
]);

export type SetupFlowDeps = Pick<
  FlowDeps,
  | "checkGhInstalled"
  | "checkGhAuth"
  | "ghRepoExists"
  | "ghCreateRepo"
  | "ghGetRepoCloneUrl"
  | "checkGitRepoExists"
  | "cloneRepo"
  | "isAlreadyCloned"
  | "writeConfig"
  | "gitSetRemoteUrl"
>;

export function defaultSetupFlowDeps(deps: InternalDeps): SetupFlowDeps {
  return {
    checkGhInstalled,
    checkGhAuth,
    ghRepoExists,
    ghCreateRepo,
    ghGetRepoCloneUrl,
    checkGitRepoExists,
    cloneRepo: (url) => cloneRepo(url, deps.configDir),
    isAlreadyCloned: () => existsSync(join(deps.configDir, ".git")),
    writeConfig: (config) =>
      writeConfig(config, deps.configDir, deps.configFile),
    gitSetRemoteUrl,
  };
}

export type SetupResult = {
  alreadyConfigured: boolean;
  config: Config;
  repoUrl?: string;
  createdRepo?: boolean;
};

export async function runSetup(
  deps: InternalDeps,
  rawInput: unknown,
  flowDeps: SetupFlowDeps,
): Promise<SetupResult> {
  const existing = readConfig(deps.configFile);
  const clonePresent = existsSync(join(deps.configDir, ".git"));

  if (rawInput === undefined) {
    if (existing && clonePresent) {
      return { alreadyConfigured: true, config: existing };
    }
    throw new InternalCommandError(
      "input-required",
      'Setup needs a remote preference: {"remote":"gh"} to auto-create a private repo via the GitHub CLI, or {"remote":"git","repoUrl":"..."} for any accessible git remote.',
    );
  }

  const parsed = SetupInputSchema.safeParse(rawInput);
  if (!parsed.success) throw invalidInputError("setup", parsed.error);
  const input = parsed.data;

  if (existing && clonePresent && !input.force) {
    throw new InternalCommandError(
      "already-configured",
      `This machine is already configured (remote: ${existing.remote}). Pass force:true to reconfigure the remote.`,
    );
  }

  let url: string;
  let createdRepo = false;

  if (input.remote === "gh") {
    const precheck = await runGhPrecheck(flowDeps);
    if (precheck.type === "gh-not-installed") {
      throw new InternalCommandError(
        "gh-not-installed",
        "The GitHub CLI (gh) is not installed. Install it or use a custom git remote URL instead.",
      );
    }
    if (precheck.type === "needs-auth") {
      throw new InternalCommandError(
        "gh-not-authenticated",
        "The GitHub CLI is not authenticated. Run gh auth login, or use a custom git remote URL instead.",
      );
    }

    const repoCheck = await runGhRepoCheck(GH_REPO_NAME, flowDeps);
    if (repoCheck.type === "found") {
      url = repoCheck.url;
    } else if (repoCheck.type === "not-found") {
      const created = await runGhCreateRepo(GH_REPO_NAME, flowDeps);
      if (created.type === "error") {
        throw new InternalCommandError("gh-create-failed", created.message);
      }
      url = created.url;
      createdRepo = true;
    } else {
      throw new InternalCommandError("gh-error", repoCheck.message);
    }
  } else {
    const validation = await runGitUrlValidation(input.repoUrl, flowDeps);
    if (validation.type === "error") {
      throw new InternalCommandError("invalid-repo-url", validation.message);
    }
    url = input.repoUrl;
  }

  const cloned = await runClone(url, input.remote, deps.configDir, flowDeps);
  if (cloned.type === "error") {
    throw new InternalCommandError("clone-failed", cloned.message);
  }

  return {
    alreadyConfigured: false,
    config: cloned.config,
    repoUrl: url,
    createdRepo,
  };
}
