import { spawnSync } from "node:child_process";
import { runInternalCli } from "./internal/cli";

const SKILL_SOURCE = "floklein/git-agents";

const args = process.argv.slice(2);

if (args[0] === "--internal") {
  process.exitCode = await runInternalCli(args.slice(1));
} else {
  if (args[0] === "pull" || args[0] === "push") {
    console.log(
      `The ${args[0]} command has moved into the skill: run /git-agents ${args[0]} inside your coding agent.\n`,
    );
  }

  console.log("Installing the git-agents skill into your harnesses...\n");
  const install = spawnSync("npx", ["-y", "skills", "add", SKILL_SOURCE], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (install.status === 0) {
    console.log("\nDone. Open your coding agent and run: /git-agents setup");
  } else {
    console.error(
      `\nSkill installation did not complete. Retry with: npx skills add ${SKILL_SOURCE}`,
    );
    process.exitCode = install.status ?? 1;
  }
}
