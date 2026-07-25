import { useState } from "react";
import { Box, useApp, useInput, useWindowSize } from "ink";
import { MainMenuScreen } from "./screens/MainMenuScreen";
import { SyncScreen } from "./screens/SyncScreen";
import { SetupScreen } from "./screens/SetupScreen";
import type { Config, Screen } from "./types";

type Props = {
  initialScreen: Screen;
  initialConfig?: Config;
};

export function App({ initialScreen, initialConfig }: Props) {
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [config, setConfig] = useState<Config | undefined>(initialConfig);
  const { exit } = useApp();
  const { rows } = useWindowSize();

  useInput((input, key) => {
    if (key.ctrl && input === "c") exit();
  });

  let content;

  if (screen.id === "setup") {
    content = (
      <SetupScreen
        existingConfig={screen.existingConfig ?? config}
        onComplete={(newConfig) => {
          setConfig(newConfig);
          setScreen({ id: "main" });
        }}
      />
    );
  } else if (screen.id === "sync") {
    content = (
      <SyncScreen
        mode={screen.mode}
        onBack={() => setScreen({ id: "main" })}
      />
    );
  } else {
    content = <MainMenuScreen onNavigate={(next) => setScreen(next)} />;
  }

  return (
    <Box flexDirection="column" height={rows}>
      {content}
    </Box>
  );
}
