import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import BigText from "ink-big-text";
import { SelectMenu } from "../components/SelectMenu";
import { CONFIG_DIR } from "../utils/config";
import { gitPull, gitAddCommitPush } from "../utils/shell";
import { AGENT_DEFS } from "../utils/agentDefs";
import { runSyncLoad, runSyncExecute, type AgentDiffEntry } from "../utils/flows";

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
    gitAddCommitPush: (dir: string, message: string) =>
      gitAddCommitPush(dir, message, signal),
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
      setStatus("Comparing agents...");
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
      mode === "pull"
        ? "Copying agents from remote..."
        : "Copying agents to remote...",
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
    (acc, entry) => acc + entry.remoteCount,
    0,
  );
  const totalLocal = agentDiffs.reduce(
    (acc, entry) => acc + entry.localCount,
    0,
  );

  const hasChanges = agentDiffs.some((entry) =>
    entry.folderDiffs.some(
      (folderDiff) =>
        folderDiff.diff.added.length > 0 ||
        folderDiff.diff.removed.length > 0 ||
        folderDiff.diff.modified.length > 0,
    ),
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
            Remote: <Text color="#8be9fd">{totalRemote} skills</Text>
          </Text>
          <Text>
            Local: <Text color="#8be9fd">{totalLocal} skills</Text>
          </Text>
        </Box>

        {agentDiffs.length === 0 && <Text dimColor>No agents found</Text>}

        {agentDiffs.map((entry) => (
          <Box
            key={entry.defs.map((definition) => definition.id).join(",")}
            flexDirection="column"
            marginTop={1}
          >
            <Box flexDirection="row" justifyContent="space-between">
              <Text color="#bd93f9">
                {entry.defs.map((definition) => definition.name).join(", ")}
              </Text>
              <Text dimColor>
                {entry.remoteCount}↓ / {entry.localCount}↑
              </Text>
            </Box>
            {entry.folderDiffs.map((folderDiff) => {
              const diff = folderDiff.diff;
              const folderHasChanges =
                diff.added.length > 0 ||
                diff.removed.length > 0 ||
                diff.modified.length > 0;
              return (
                <Box key={folderDiff.folder} flexDirection="column">
                  <Text dimColor>  {folderDiff.folder}/</Text>
                  {diff.added.map((entry) => (
                    <Text key={entry.name}>
                      <Text color="#50fa7b">    + </Text>
                      {entry.name}
                    </Text>
                  ))}
                  {diff.removed.map((entry) => (
                    <Text key={entry.name}>
                      <Text color="#ff5555">    - </Text>
                      {entry.name}
                    </Text>
                  ))}
                  {diff.modified.map((entry) => (
                    <Text key={entry.name}>
                      <Text color="#ffb86c">    ~ </Text>
                      {entry.name}
                    </Text>
                  ))}
                  {!folderHasChanges && diff.unchanged.length > 0 && (
                    <Text dimColor>
                      {"    "}
                      {diff.unchanged.length} unchanged
                    </Text>
                  )}
                </Box>
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
          <Text dimColor>(No is default, press Enter to cancel)</Text>
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
