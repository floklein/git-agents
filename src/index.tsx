import type { Screen } from "./types";

const args = process.argv.slice(2);

if (args[0] === "--internal") {
  const { runInternalCli } = await import("./internal/cli");
  process.exitCode = await runInternalCli(args.slice(1));
} else {
  const [{ render }, { readConfig }, { App }] = await Promise.all([
    import("ink"),
    import("./utils/config"),
    import("./App"),
  ]);

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
}
