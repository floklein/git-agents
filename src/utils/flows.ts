import { getSyncDirForAgent } from "./config";
import { diffAgents, copyAgentsDir, listAgents } from "./agents";
import type { AgentDef } from "./agentDefs";
import type { Config, AgentsDiff, RemoteType } from "../types";

type ShellResult = { ok: boolean; output?: string; error?: string };

export type FlowDeps = {
  checkGhInstalled: () => Promise<ShellResult>;
  checkGhAuth: () => Promise<ShellResult>;
  ghRepoExists: (name: string) => Promise<ShellResult>;
  ghCreateRepo: (name: string) => Promise<ShellResult>;
  ghGetRepoCloneUrl: (name: string) => Promise<ShellResult>;
  checkGitRepoExists: (url: string) => Promise<ShellResult>;
  cloneRepo: (url: string, dest: string) => Promise<ShellResult>;
  isAlreadyCloned: () => boolean;
  writeConfig: (config: Config) => void;
  gitPull: (dir: string) => Promise<ShellResult>;
  gitAddCommitPush: (dir: string, message: string) => Promise<ShellResult>;
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
  deps: Pick<FlowDeps, "cloneRepo" | "isAlreadyCloned" | "writeConfig">
): Promise<CloneResult> {
  const config: Config = { remote, repoUrl: remote === "git" ? url : undefined };

  if (deps.isAlreadyCloned()) {
    deps.writeConfig(config);
    return { type: "ok", config };
  }

  const result = await deps.cloneRepo(url, "");
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

export type AgentDiffEntry = {
  def: AgentDef;
  diff: AgentsDiff;
  remoteCount: number;
  localCount: number;
};

export type SyncLoadResult =
  | { type: "ok"; agentDiffs: AgentDiffEntry[] }
  | { type: "error"; message: string };

export async function runSyncLoad(
  mode: "pull" | "push",
  agentDefs: AgentDef[],
  configDir: string,
  deps: Pick<FlowDeps, "gitPull">
): Promise<SyncLoadResult> {
  const pullResult = await deps.gitPull(configDir);
  if (!pullResult.ok) {
    return { type: "error", message: `Failed to pull remote: ${pullResult.error ?? "unknown error"}` };
  }

  const seen = new Map<string, AgentDef[]>();
  for (const def of agentDefs) {
    const existing = seen.get(def.globalPath) ?? [];
    seen.set(def.globalPath, [...existing, def]);
  }

  const entries: AgentDiffEntry[] = [];
  for (const [globalPath, defs] of seen) {
    const syncDir = getSyncDirForAgent(globalPath);
    const sourceDir = mode === "pull" ? syncDir : globalPath;
    const destDir = mode === "pull" ? globalPath : syncDir;
    const d = diffAgents(sourceDir, destDir);
    const srcList = listAgents(sourceDir);
    const dstList = listAgents(destDir);
    if (srcList.length === 0 && dstList.length === 0) continue;
    for (const def of defs) {
      entries.push({
        def,
        diff: d,
        remoteCount: mode === "pull" ? srcList.length : dstList.length,
        localCount: mode === "pull" ? dstList.length : srcList.length,
      });
    }
  }

  return { type: "ok", agentDiffs: entries };
}

export type SyncExecuteResult =
  | { type: "ok"; message: string }
  | { type: "error"; message: string };

export async function runSyncExecute(
  mode: "pull" | "push",
  agentDiffs: AgentDiffEntry[],
  configDir: string,
  deps: Pick<FlowDeps, "gitAddCommitPush">
): Promise<SyncExecuteResult> {
  const copied = new Set<string>();
  try {
    for (const entry of agentDiffs) {
      if (copied.has(entry.def.globalPath)) continue;
      copied.add(entry.def.globalPath);
      const syncDir = getSyncDirForAgent(entry.def.globalPath);
      const sourceDir = mode === "pull" ? syncDir : entry.def.globalPath;
      const destDir = mode === "pull" ? entry.def.globalPath : syncDir;
      copyAgentsDir(sourceDir, destDir);
    }
  } catch (e: any) {
    return { type: "error", message: `Failed to copy agents: ${e.message}` };
  }

  if (mode === "push") {
    const pushResult = await deps.gitAddCommitPush(
      configDir,
      `sync: update agents from local (${new Date().toISOString().slice(0, 10)})`
    );
    if (!pushResult.ok) {
      return { type: "error", message: `Failed to push: ${pushResult.error ?? "unknown error"}` };
    }
  }

  return {
    type: "ok",
    message: mode === "pull" ? "Pull complete! Local agents updated." : "Push complete! Remote updated.",
  };
}
