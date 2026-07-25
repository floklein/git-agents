import { Box, Text, useApp, useInput } from "ink";
import BigText from "ink-big-text";
import { SelectMenu } from "../components/SelectMenu";
import type { Screen } from "../types";

type Props = {
  onNavigate: (screen: Screen) => void;
};

const MENU_ITEMS = [
  {
    name: "Pull",
    description: "Download agents from remote to local",
    value: "pull",
  },
  {
    name: "Push",
    description: "Upload local agents to remote",
    value: "push",
  },
  {
    name: "Edit Config",
    description: "Change remote configuration",
    value: "setup",
  },
] as const;

export function MainMenuScreen({ onNavigate }: Props) {
  const { exit } = useApp();

  useInput((_input, key) => {
    if (key.escape) exit();
  });

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      flexGrow={1}
    >
      <Box flexDirection="column" alignItems="center">
        <BigText text="git-agents" font="tiny" />
        <Text>Sync your AI agent directories with a remote git repo</Text>
      </Box>

      <Box flexDirection="column" width={56} marginTop={2}>
        <SelectMenu
          options={MENU_ITEMS}
          onSelect={(item) => {
            if (item.value === "pull") {
              onNavigate({ id: "sync", mode: "pull" });
            } else if (item.value === "push") {
              onNavigate({ id: "sync", mode: "push" });
            } else {
              onNavigate({ id: "setup" });
            }
          }}
        />
      </Box>

      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate  Enter select  Esc or Ctrl+C quit</Text>
      </Box>
    </Box>
  );
}
