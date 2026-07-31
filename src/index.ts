import { spawnSync } from "node:child_process";
import { runInternalCli } from "./internal/cli";
import pkg from "../package.json" with { type: "json" };

const SKILL_SOURCE = "floklein/git-agents";
const SKILL_SUBCOMMANDS = ["setup", "sync", "status"];
const MERGED_SUBCOMMANDS = ["pull", "push"];

const USAGE = `git-agents ${pkg.version}

Usage:
  npx git-agents            install the git-agents skill into your harnesses
  git-agents --help         show this help
  git-agents --version      print the version

Everything else happens inside your coding agent:
  /git-agents setup | sync | sync unify | status
`;

function bootstrap(): void {
  console.log("Installing the git-agents skill into your harnesses...\n");
  const install = spawnSync("npx", ["-y", "skills", "add", SKILL_SOURCE], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (install.status === 0) {
    console.log("\nDone. Open your coding agent and run: /git-agents setup");
  } else {
    console.error(
      `\nSkill installation did not complete. Retry with: npx -y skills add ${SKILL_SOURCE}`,
    );
    process.exitCode = install.status ?? 1;
  }
}

const args = process.argv.slice(2);
const first = args[0];

if (first === "--internal") {
  process.exitCode = await runInternalCli(args.slice(1));
} else if (first === undefined) {
  bootstrap();
} else if (first === "--help" || first === "-h") {
  console.log(USAGE);
} else if (first === "--version" || first === "-v") {
  console.log(pkg.version);
} else if (SKILL_SUBCOMMANDS.includes(first)) {
  console.log(
    `The ${first} command lives in the skill now: run /git-agents ${first} inside your coding agent.\n` +
      "If the skill is not installed yet, run: npx git-agents",
  );
} else if (MERGED_SUBCOMMANDS.includes(first)) {
  console.log(
    `The ${first} command merged into sync: run /git-agents sync inside your coding agent.\n` +
      "If the skill is not installed yet, run: npx git-agents",
  );
} else {
  console.error(`Unknown argument: ${first}\n\n${USAGE}`);
  process.exitCode = 1;
}
