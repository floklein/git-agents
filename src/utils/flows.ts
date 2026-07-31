import type { Config, RemoteType, ShellResult } from "../types";

export type FlowDeps = {
  checkGhInstalled: () => Promise<ShellResult>;
  checkGhAuth: () => Promise<ShellResult>;
  ghRepoExists: (name: string) => Promise<ShellResult>;
  ghCreateRepo: (name: string) => Promise<ShellResult>;
  ghGetRepoCloneUrl: (name: string) => Promise<ShellResult>;
  checkGitRepoExists: (url: string) => Promise<ShellResult>;
  cloneRepo: (url: string) => Promise<ShellResult>;
  isAlreadyCloned: () => boolean;
  writeConfig: (config: Config) => void;
  gitSetRemoteUrl: (dir: string, url: string) => Promise<ShellResult>;
};

export type GhPrecheckResult =
  | { type: "ok" }
  | { type: "gh-not-installed" }
  | { type: "needs-auth" };

export async function runGhPrecheck(
  deps: Pick<FlowDeps, "checkGhInstalled" | "checkGhAuth">
): Promise<GhPrecheckResult> {
  const installed = await deps.checkGhInstalled();
  if (!installed.ok) return { type: "gh-not-installed" };

  const auth = await deps.checkGhAuth();
  if (!auth.ok) return { type: "needs-auth" };

  return { type: "ok" };
}

export type GhRepoCheckResult =
  | { type: "found"; url: string }
  | { type: "not-found" }
  | { type: "error"; message: string };

export async function runGhRepoCheck(
  repoName: string,
  deps: Pick<FlowDeps, "ghRepoExists" | "ghGetRepoCloneUrl">
): Promise<GhRepoCheckResult> {
  const exists = await deps.ghRepoExists(repoName);
  if (!exists.ok) return { type: "not-found" };

  const urlResult = await deps.ghGetRepoCloneUrl(repoName);
  if (!urlResult.ok || !urlResult.output) {
    return { type: "error", message: "Could not get repo URL from gh CLI." };
  }
  return { type: "found", url: urlResult.output.trim() };
}

export type GhCreateRepoResult =
  | { type: "ok"; url: string }
  | { type: "error"; message: string };

export async function runGhCreateRepo(
  repoName: string,
  deps: Pick<FlowDeps, "ghCreateRepo" | "ghGetRepoCloneUrl">
): Promise<GhCreateRepoResult> {
  const created = await deps.ghCreateRepo(repoName);
  if (!created.ok) {
    return { type: "error", message: `Failed to create repo: ${created.error ?? "unknown error"}` };
  }

  const urlResult = await deps.ghGetRepoCloneUrl(repoName);
  if (!urlResult.ok || !urlResult.output) {
    return { type: "error", message: "Could not get repo URL after creating it." };
  }
  return { type: "ok", url: urlResult.output.trim() };
}

export type CloneResult =
  | { type: "ok"; config: Config }
  | { type: "error"; message: string };

export async function runClone(
  url: string,
  remote: RemoteType,
  configDir: string,
  deps: Pick<FlowDeps, "cloneRepo" | "isAlreadyCloned" | "writeConfig" | "gitSetRemoteUrl">
): Promise<CloneResult> {
  const config: Config = { remote, repoUrl: remote === "git" ? url : undefined };

  if (deps.isAlreadyCloned()) {
    const setUrlResult = await deps.gitSetRemoteUrl(configDir, url);
    if (!setUrlResult.ok) {
      return { type: "error", message: `Failed to update remote URL: ${setUrlResult.error ?? "unknown error"}` };
    }
    deps.writeConfig(config);
    return { type: "ok", config };
  }

  const result = await deps.cloneRepo(url);
  if (!result.ok) {
    return { type: "error", message: `Failed to clone: ${result.error ?? "unknown error"}` };
  }

  deps.writeConfig(config);
  return { type: "ok", config };
}

export type GitUrlValidationResult =
  | { type: "ok" }
  | { type: "error"; message: string };

export async function runGitUrlValidation(
  url: string,
  deps: Pick<FlowDeps, "checkGitRepoExists">
): Promise<GitUrlValidationResult> {
  const exists = await deps.checkGitRepoExists(url);
  if (!exists.ok) {
    return { type: "error", message: `Cannot reach repository: ${url}` };
  }
  return { type: "ok" };
}
