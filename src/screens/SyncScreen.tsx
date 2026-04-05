import { useState, useEffect } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { getSyncDirForAgent, CONFIG_DIR } from "../utils/config";
import { gitPull, gitAddCommitPush } from "../utils/shell";
import { diffAgents, copyAgentsDir, listAgents } from "../utils/agents";
import { AGENT_DEFS, type AgentDef } from "../utils/agentDefs";
import type { AgentsDiff } from "../types";

type Stage = "loading" | "review" | "executing" | "done";

type AgentDiffEntry = {
  def: AgentDef;
  diff: AgentsDiff;
  remoteCount: number;
  localCount: number;
};

type Props = {
  mode: "pull" | "push";
  onBack: () => void;
};

export function SyncScreen({ mode, onBack }: Props) {
  const [stage, setStage] = useState<Stage>("loading");
  const [status, setStatus] = useState("Fetching remote...");
  const [agentDiffs, setAgentDiffs] = useState<AgentDiffEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState("");

  useKeyboard((key) => {
    if (key.name === "escape") {
      if (stage === "done" || stage === "review") onBack();
    }
  });

  useEffect(() => {
    async function load() {
      setStatus("Pulling remote changes...");
      const pullResult = await gitPull(CONFIG_DIR);
      if (!pullResult.ok) {
        setError(`Failed to pull remote: ${pullResult.error ?? "unknown error"}`);
        setStage("done");
        return;
      }

      setStatus("Comparing agents...");

      const seen = new Map<string, AgentDef[]>();
      for (const def of AGENT_DEFS) {
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

      setAgentDiffs(entries);
      setStage("review");
    }
    load();
  }, []);

  async function executeSync(confirmed: boolean) {
    if (!confirmed) {
      onBack();
      return;
    }

    setStage("executing");
    setStatus(mode === "pull" ? "Copying agents from remote..." : "Copying agents to remote...");

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
      setError(`Failed to copy agents: ${e.message}`);
      setStage("done");
      return;
    }

    if (mode === "push") {
      setStatus("Committing and pushing to remote...");
      const pushResult = await gitAddCommitPush(
        CONFIG_DIR,
        `sync: update agents from local (${new Date().toISOString().slice(0, 10)})`
      );
      if (!pushResult.ok) {
        setError(`Failed to push: ${pushResult.error ?? "unknown error"}`);
        setStage("done");
        return;
      }
    }

    setDoneMessage(mode === "pull" ? "Pull complete! Local agents updated." : "Push complete! Remote updated.");
    setError(null);
    setStage("done");
  }

  const title = mode === "pull" ? "Pull" : "Push";

  if (stage === "loading" || stage === "executing") {
    return (
      <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <text>{status}</text>
      </box>
    );
  }

  if (stage === "done") {
    return (
      <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} gap={1}>
        {error ? (
          <text fg="#ff5555">{error}</text>
        ) : (
          <text fg="#50fa7b">{doneMessage}</text>
        )}
        <text attributes={TextAttributes.DIM}>Press Esc to go back</text>
      </box>
    );
  }

  // review stage
  const seenPaths = new Set<string>();
  const totalRemote = agentDiffs.reduce((acc, e) => {
    if (seenPaths.has(e.def.globalPath)) return acc;
    seenPaths.add(e.def.globalPath);
    return acc + e.remoteCount;
  }, 0);
  seenPaths.clear();
  const totalLocal = agentDiffs.reduce((acc, e) => {
    if (seenPaths.has(e.def.globalPath)) return acc;
    seenPaths.add(e.def.globalPath);
    return acc + e.localCount;
  }, 0);

  const hasChanges = agentDiffs.some(
    (e) => e.diff.added.length > 0 || e.diff.removed.length > 0 || e.diff.modified.length > 0
  );

  return (
    <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} gap={1}>
      <ascii-font font="tiny" text={title} />

      <box
        flexDirection="column"
        border={true}
        borderStyle="rounded"
        title=" Comparison "
        paddingX={2}
        paddingY={1}
        width={60}
        gap={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text>
            <span>Remote: </span>
            <span fg="#8be9fd">{totalRemote} skills</span>
          </text>
          <text>
            <span>Local: </span>
            <span fg="#8be9fd">{totalLocal} skills</span>
          </text>
        </box>

        {agentDiffs.length === 0 && (
          <text attributes={TextAttributes.DIM}>No agents found</text>
        )}

        {agentDiffs.map((entry) => {
          const d = entry.diff;
          const agentHasChanges = d.added.length > 0 || d.removed.length > 0 || d.modified.length > 0;
          return (
            <box key={entry.def.id} flexDirection="column">
              <box flexDirection="row" justifyContent="space-between">
                <text fg="#bd93f9">{entry.def.name}</text>
                <text attributes={TextAttributes.DIM}>
                  {entry.remoteCount}↓ / {entry.localCount}↑
                </text>
              </box>
              {d.added.map((e) => (
                <text key={e.name}>
                  <span fg="#50fa7b">  + </span>
                  <span>{e.name}</span>
                </text>
              ))}
              {d.removed.map((e) => (
                <text key={e.name}>
                  <span fg="#ff5555">  - </span>
                  <span>{e.name}</span>
                </text>
              ))}
              {d.modified.map((e) => (
                <text key={e.name}>
                  <span fg="#ffb86c">  ~ </span>
                  <span>{e.name}</span>
                </text>
              ))}
              {!agentHasChanges && d.unchanged.length > 0 && (
                <text attributes={TextAttributes.DIM}>
                  {"  "}{d.unchanged.length} skill{d.unchanged.length !== 1 ? "s" : ""} unchanged
                </text>
              )}
            </box>
          );
        })}
      </box>

      <box flexDirection="column" alignItems="center" gap={1}>
        <text>
          <span>Confirm {mode}? </span>
          <span attributes={TextAttributes.DIM}>(No is default — press Enter to cancel)</span>
        </text>
        <select
          focused={true}
          options={[
            { name: "No, cancel", description: "Go back to main menu" },
            {
              name: `Yes, ${mode}`,
              description: hasChanges ? "Apply changes" : "No changes to apply",
            },
          ]}
          onSelect={(index) => executeSync(index === 1)}
          width={30}
          height={4}
        />
      </box>

      <text attributes={TextAttributes.DIM}>Esc to cancel</text>
    </box>
  );
}
