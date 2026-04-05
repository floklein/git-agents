import { existsSync, readdirSync, statSync, mkdirSync, cpSync } from "fs";
import { join } from "path";
import type { AgentEntry, AgentsDiff } from "../types";

export function listAgents(dir: string): AgentEntry[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const agentDir = join(dir, d.name);
        let fileCount = 0;
        try {
          fileCount = readdirSync(agentDir).length;
        } catch {}
        return { name: d.name, fileCount };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function diffAgents(sourceDir: string, destDir: string): AgentsDiff {
  const source = listAgents(sourceDir);
  const dest = listAgents(destDir);

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
      if (entry.fileCount !== destEntry.fileCount) {
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

export function copyAgentsDir(fromDir: string, toDir: string): void {
  mkdirSync(toDir, { recursive: true });
  cpSync(fromDir, toDir, { recursive: true, force: true });
}
