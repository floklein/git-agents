import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import BigText from "ink-big-text";
import { SelectMenu } from "../components/SelectMenu";
import { CONFIG_DIR } from "../utils/config";
import { gitPull, gitAddCommitPush } from "../utils/shell";
import { AGENT_DEFS } from "../utils/agentDefs";
import {
  runSyncLoad,
  runSyncExecute,
  type AgentDiffEntry,
} from "../utils/flows";

type Stage = "loading" | "review" | "executing" | "done";

type Props = {
  mode: "pull" | "push";
  signal: AbortSignal;
  onBack: () => void;
};

export function SyncScreen({ mode, signal, onBack }: Props) {
  const [stage, setStage] = useState<Stage>("loading");
  const [status, setStatus] = useState("Fetching remote...");
  const [agentDiffs, setAgentDiffs] = useState<AgentDiffEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState("");

  useInput((_input, key) => {
    if (key.escape && (stage === "done" || stage === "review")) {
      onBack();
    }
  });

  const shellDeps = {
    gitPull: (dir: string) => gitPull(dir, signal),
    gitAddCommitPush: (dir: string, message: string, paths: string[]) =>
      gitAddCommitPush(dir, message, paths, signal),
  };

  useEffect(() => {
    async function load() {
      setStatus("Pulling remote changes...");
      const result = await runSyncLoad(
        mode,
        AGENT_DEFS,
        CONFIG_DIR,
        shellDeps,
      );
      if (result.type === "error") {
        setError(result.message);
        setStage("done");
        return;
      }
      setStatus("Comparing files...");
      setAgentDiffs(result.agentDiffs);
      setStage("review");
    }
    void load();
  }, []);

  async function executeSync(confirmed: boolean) {
    if (!confirmed) {
      onBack();
      return;
    }

    setStage("executing");
    setStatus(
      mode === "pull" ? "Updating local files..." : "Updating remote files...",
    );

    const result = await runSyncExecute(
      mode,
      agentDiffs,
      CONFIG_DIR,
      shellDeps,
    );
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
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
      >
        <Text>{status}</Text>
      </Box>
    );
  }

  if (stage === "done") {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
      >
        {error ? (
          <Text color="#ff5555">{error}</Text>
        ) : (
          <Text color="#50fa7b">{doneMessage}</Text>
        )}
        <Text dimColor>Press Esc to go back</Text>
      </Box>
    );
  }

  const totalRemote = agentDiffs.reduce(
    (total, entry) => total + entry.remoteCount,
    0,
  );
  const totalLocal = agentDiffs.reduce(
    (total, entry) => total + entry.localCount,
    0,
  );
  const hasChanges = agentDiffs.some((entry) =>
    entry.pathDiffs.some((pathDiff) => pathDiff.status !== "unchanged"),
  );

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      flexGrow={1}
    >
      <BigText text={title} font="tiny" />

      <Box
        flexDirection="column"
        borderStyle="round"
        paddingX={2}
        paddingY={1}
        width={60}
        marginTop={1}
      >
        <Text bold>Comparison</Text>
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            Remote: <Text color="#8be9fd">{totalRemote} files</Text>
          </Text>
          <Text>
            Local: <Text color="#8be9fd">{totalLocal} files</Text>
          </Text>
        </Box>

        {agentDiffs.length === 0 && (
          <Text dimColor>No synced files found</Text>
        )}

        {agentDiffs.map((entry) => (
          <Box
            key={entry.def.id}
            flexDirection="column"
            marginTop={1}
          >
            <Box flexDirection="row" justifyContent="space-between">
              <Text color="#bd93f9">{entry.def.name}</Text>
              <Text dimColor>
                {entry.remoteCount}↓ / {entry.localCount}↑
              </Text>
            </Box>
            {entry.pathDiffs.map((pathDiff) => {
              const marker = pathDiff.status === "added"
                ? "+"
                : pathDiff.status === "removed"
                  ? "-"
                  : pathDiff.status === "modified"
                    ? "~"
                    : "=";
              const color = pathDiff.status === "added"
                ? "#50fa7b"
                : pathDiff.status === "removed"
                  ? "#ff5555"
                  : pathDiff.status === "modified"
                    ? "#ffb86c"
                    : undefined;

              return (
                <Text
                  key={pathDiff.path}
                  dimColor={pathDiff.status === "unchanged"}
                >
                  <Text color={color}>  {marker} </Text>
                  {pathDiff.path}
                </Text>
              );
            })}
          </Box>
        ))}
      </Box>

      <Box
        flexDirection="column"
        alignItems="center"
        marginTop={1}
        flexShrink={0}
      >
        <Text>
          Confirm {mode}?{" "}
          <Text dimColor>(No is default. Press Enter to cancel)</Text>
        </Text>
        <Box flexDirection="column" width={46}>
          <SelectMenu
            key={`confirm-${mode}`}
            options={[
              {
                name: "No, cancel",
                description: "Go back to main menu",
                value: "cancel",
              },
              {
                name: `Yes, ${mode}`,
                description: hasChanges
                  ? "Apply changes"
                  : "No changes to apply",
                value: "confirm",
              },
            ] as const}
            onSelect={(item) => {
              void executeSync(item.value === "confirm");
            }}
          />
        </Box>
      </Box>

      <Box flexShrink={0}>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    </Box>
  );
}
