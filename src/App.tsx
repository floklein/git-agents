import { useState } from "react";
import { useKeyboard } from "@opentui/react";
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

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") process.exit(0);
  });

  if (screen.id === "setup") {
    return (
      <SetupScreen
        existingConfig={screen.existingConfig ?? config}
        onComplete={(newConfig) => {
          setConfig(newConfig);
          setScreen({ id: "main" });
        }}
      />
    );
  }

  if (screen.id === "sync") {
    return (
      <SyncScreen
        mode={screen.mode}
        onBack={() => setScreen({ id: "main" })}
      />
    );
  }

  return (
    <MainMenuScreen
      onNavigate={(next) => setScreen(next)}
    />
  );
}
