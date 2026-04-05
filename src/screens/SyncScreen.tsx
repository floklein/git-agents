import { useState, useEffect } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { CONFIG_DIR } from "../utils/config";
import { gitPull, gitAddCommitPush } from "../utils/shell";
import { AGENT_DEFS } from "../utils/agentDefs";
import { runSyncLoad, runSyncExecute, type AgentDiffEntry } from "../utils/flows";

type Stage = "loading" | "review" | "executing" | "done";

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

  const shellDeps = { gitPull, gitAddCommitPush };

  useEffect(() => {
    async function load() {
      setStatus("Pulling remote changes...");
      const result = await runSyncLoad(mode, AGENT_DEFS, CONFIG_DIR, shellDeps);
      if (result.type === "error") {
        setError(result.message);
        setStage("done");
        return;
      }
      setStatus("Comparing agents...");
      setAgentDiffs(result.agentDiffs);
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

    const result = await runSyncExecute(mode, agentDiffs, CONFIG_DIR, shellDeps);
    if (result.type === "error") {
      setError(result.message);
    } else {
      setDoneMessage(result.message);
      setError(null);
    }
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
  const totalRemote = agentDiffs.reduce((acc, e) => acc + e.remoteCount, 0);
  const totalLocal = agentDiffs.reduce((acc, e) => acc + e.localCount, 0);

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
            <box key={entry.defs.map((d) => d.id).join(",")} flexDirection="column">
              <box flexDirection="row" justifyContent="space-between">
                <text fg="#bd93f9">{entry.defs.map((d) => d.name).join(", ")}</text>
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
