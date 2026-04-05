import { useKeyboard } from "@opentui/react";
import type { Screen } from "../types";

type Props = {
  onNavigate: (screen: Screen) => void;
};

export function MainMenuScreen({ onNavigate }: Props) {
  useKeyboard((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      process.exit(0);
    }
  });

  return (
    <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <box flexDirection="column" alignItems="center" gap={1}>
        <ascii-font font="tiny" text="git-agents" />
        <text>Sync your Claude agents directory with a remote git repo</text>
      </box>

      <box flexDirection="column" width={40} marginTop={2}>
        <select
          focused={true}
          options={[
            { name: "Pull", description: "Download agents from remote to local" },
            { name: "Push", description: "Upload local agents to remote" },
            { name: "Edit Config", description: "Change remote configuration" },
          ]}
          onSelect={(index) => {
            if (index === 0) onNavigate({ id: "sync", mode: "pull" });
            else if (index === 1) onNavigate({ id: "sync", mode: "push" });
            else if (index === 2) onNavigate({ id: "setup" });
          }}
        />
      </box>

      <box marginTop={1}>
        <text>↑↓ navigate  Enter select  Ctrl+C quit</text>
      </box>
    </box>
  );
}
