import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
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

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(
  <App initialScreen={initialScreen} initialConfig={config ?? undefined} />
);
