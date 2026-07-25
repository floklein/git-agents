import { render } from "ink";
import { readConfig } from "./utils/config";
import { App } from "./App";
import type { Screen } from "./types";

const args = process.argv.slice(2);
const directCommand = args[0];

const config = readConfig();

const initialScreen: Screen =
  !config
    ? { id: "setup" }
    : directCommand === "pull"
    ? { id: "sync", mode: "pull" }
    : directCommand === "push"
    ? { id: "sync", mode: "push" }
    : { id: "main" };

const app = render(
  <App initialScreen={initialScreen} initialConfig={config ?? undefined} />,
  { alternateScreen: true, exitOnCtrlC: false },
);

await app.waitUntilExit();
