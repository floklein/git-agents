import { useState, useEffect } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { AGENTS_LOCAL_DIR, AGENTS_SYNC_DIR, CONFIG_DIR } from "../utils/config";
import { gitPull, gitAddCommitPush } from "../utils/shell";
import { diffAgents, copyAgentsDir, listAgents } from "../utils/agents";
import type { AgentsDiff } from "../types";

type Stage = "loading" | "review" | "executing" | "done";

type Props = {
  mode: "pull" | "push";
  onBack: () => void;
};

export function SyncScreen({ mode, onBack }: Props) {
  const [stage, setStage] = useState<Stage>("loading");
  const [status, setStatus] = useState("Fetching remote...");
  const [diff, setDiff] = useState<AgentsDiff | null>(null);
  const [localCount, setLocalCount] = useState(0);
  const [remoteCount, setRemoteCount] = useState(0);
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
      const sourceDir = mode === "pull" ? AGENTS_SYNC_DIR : AGENTS_LOCAL_DIR;
      const destDir = mode === "pull" ? AGENTS_LOCAL_DIR : AGENTS_SYNC_DIR;

      const d = diffAgents(sourceDir, destDir);
      const srcList = listAgents(sourceDir);
      const dstList = listAgents(destDir);

      setDiff(d);
      // For pull: src=remote, dst=local. For push: src=local, dst=remote.
      setRemoteCount(mode === "pull" ? srcList.length : dstList.length);
      setLocalCount(mode === "pull" ? dstList.length : srcList.length);
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

    const sourceDir = mode === "pull" ? AGENTS_SYNC_DIR : AGENTS_LOCAL_DIR;
    const destDir = mode === "pull" ? AGENTS_LOCAL_DIR : AGENTS_SYNC_DIR;

    try {
      copyAgentsDir(sourceDir, destDir);
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
  const d = diff!;
  const hasChanges = d.added.length > 0 || d.removed.length > 0 || d.modified.length > 0;

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
            <span fg="#8be9fd">{remoteCount} skills</span>
          </text>
          <text>
            <span>Local: </span>
            <span fg="#8be9fd">{localCount} skills</span>
          </text>
        </box>

        {!hasChanges && (
          <text attributes={TextAttributes.DIM}>No changes</text>
        )}

        {d.added.map((e) => (
          <text key={e.name}>
            <span fg="#50fa7b">+ </span>
            <span>{e.name}</span>
          </text>
        ))}
        {d.removed.map((e) => (
          <text key={e.name}>
            <span fg="#ff5555">- </span>
            <span>{e.name}</span>
          </text>
        ))}
        {d.modified.map((e) => (
          <text key={e.name}>
            <span fg="#ffb86c">~ </span>
            <span>{e.name}</span>
          </text>
        ))}
        {d.unchanged.length > 0 && (
          <text attributes={TextAttributes.DIM}>
            {d.unchanged.length} skill{d.unchanged.length !== 1 ? "s" : ""} unchanged
          </text>
        )}
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
