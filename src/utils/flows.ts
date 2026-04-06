import { join } from "path";
import { existsSync, readdirSync } from "fs";
import { getSyncDirForAgent } from "./config";
import { diffAgentsFromLists, copyAgentsDir, listAgents, matchesAllowlist } from "./agents";
import { getSyncFolders, type AgentDef } from "./agentDefs";
import type { Config, FolderDiff, RemoteType, ShellResult } from "../types";

function collectMatchingFolders(globalPath: string, syncDir: string, patterns: string[]): string[] {
  const names = new Set<string>();
  for (const dir of [globalPath, syncDir]) {
    if (!existsSync(dir)) continue;
    try {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory() && matchesAllowlist(d.name, patterns)) {
          names.add(d.name);
        }
      }
    } catch {}
  }
  return [...names].sort();
}

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
  gitPull: (dir: string) => Promise<ShellResult>;
  gitAddCommitPush: (dir: string, message: string) => Promise<ShellResult>;
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

export type AgentDiffEntry = {
  defs: AgentDef[];
  folderDiffs: FolderDiff[];
  syncFolders: string[];
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
    const folders = getSyncFolders(defs[0]!);

    const folderDiffs: FolderDiff[] = [];
    let remoteTotal = 0;
    let localTotal = 0;

    for (const folder of collectMatchingFolders(globalPath, syncDir, folders)) {
      const srcFolder = join(mode === "pull" ? syncDir : globalPath, folder);
      const dstFolder = join(mode === "pull" ? globalPath : syncDir, folder);
      const srcList = listAgents(srcFolder);
      const dstList = listAgents(dstFolder);
      if (srcList.length === 0 && dstList.length === 0) continue;
      remoteTotal += mode === "pull" ? srcList.length : dstList.length;
      localTotal += mode === "pull" ? dstList.length : srcList.length;
      folderDiffs.push({ folder, diff: diffAgentsFromLists(srcList, dstList) });
    }

    if (folderDiffs.length === 0) continue;
    entries.push({
      defs,
      folderDiffs,
      syncFolders: folders,
      remoteCount: remoteTotal,
      localCount: localTotal,
    });
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
      const globalPath = entry.defs[0]!.globalPath;
      if (copied.has(globalPath)) continue;
      copied.add(globalPath);
      const syncDir = getSyncDirForAgent(globalPath);
      for (const fd of entry.folderDiffs) {
        const srcFolder = join(mode === "pull" ? syncDir : globalPath, fd.folder);
        const dstFolder = join(mode === "pull" ? globalPath : syncDir, fd.folder);
        copyAgentsDir(srcFolder, dstFolder);
      }
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
