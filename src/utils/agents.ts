import { existsSync, readdirSync, statSync, mkdirSync, cpSync } from "fs";
import { join, relative } from "path";
import { createHash } from "crypto";
import type { AgentEntry, AgentsDiff } from "../types";

function computeContentHash(dir: string): string {
  const entries: [string, number][] = [];

  function walk(current: string) {
    for (const dirent of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, dirent.name);
      if (dirent.isFile()) {
        entries.push([relative(dir, fullPath), statSync(fullPath).size]);
      } else if (dirent.isDirectory()) {
        walk(fullPath);
      }
    }
  }

  walk(dir);
  entries.sort((a, b) => a[0].localeCompare(b[0]));

  const hash = createHash("sha256");
  for (const [path, size] of entries) {
    hash.update(`${path}\0${size}\0`);
  }
  return hash.digest("hex");
}

export function matchesAllowlist(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith("-*")) {
      const prefix = pattern.slice(0, -1);
      if (name === pattern.slice(0, -2) || name.startsWith(prefix)) return true;
    } else if (name === pattern) {
      return true;
    }
  }
  return false;
}

export function listAgents(dir: string, allowedFolders?: string[]): AgentEntry[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => !allowedFolders || matchesAllowlist(d.name, allowedFolders))
      .map((d) => {
        const agentDir = join(dir, d.name);
        let fileCount = 0;
        let contentHash = createHash("sha256").digest("hex");
        try {
          fileCount = readdirSync(agentDir, { withFileTypes: true }).filter(
            (e) => e.isFile(),
          ).length;
          contentHash = computeContentHash(agentDir);
        } catch {}
        return { name: d.name, fileCount, contentHash };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function diffAgents(sourceDir: string, destDir: string, allowedFolders?: string[]): AgentsDiff {
  const source = listAgents(sourceDir, allowedFolders);
  const dest = listAgents(destDir, allowedFolders);

  const sourceMap = new Map(source.map((e) => [e.name, e]));
  const destMap = new Map(dest.map((e) => [e.name, e]));

  const added: AgentEntry[] = [];
  const removed: AgentEntry[] = [];
  const modified: AgentEntry[] = [];
  const unchanged: AgentEntry[] = [];

  for (const entry of source) {
    if (!destMap.has(entry.name)) {
      added.push(entry);
    } else {
      const destEntry = destMap.get(entry.name)!;
      if (entry.contentHash !== destEntry.contentHash) {
        modified.push(entry);
      } else {
        unchanged.push(entry);
      }
    }
  }

  for (const entry of dest) {
    if (!sourceMap.has(entry.name)) {
      removed.push(entry);
    }
  }

  return { added, removed, modified, unchanged };
}

export function copyAgentsDir(fromDir: string, toDir: string, allowedFolders?: string[]): void {
  mkdirSync(toDir, { recursive: true });
  if (!allowedFolders) {
    cpSync(fromDir, toDir, { recursive: true, force: true });
    return;
  }
  const folders = readdirSync(fromDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => matchesAllowlist(d.name, allowedFolders));
  for (const folder of folders) {
    cpSync(join(fromDir, folder.name), join(toDir, folder.name), { recursive: true, force: true });
  }
}
