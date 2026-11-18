import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Runs the bootstrap entry point the way `npx git-agents <arg>` does.
function runCli(...args: string[]) {
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", ...args],
    { cwd: ROOT, encoding: "utf8" },
  );
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("bootstrap", () => {
  it.each(["setup", "sync", "edit", "harness", "status"])(
    "redirects %s typed at the terminal into the skill",
    (subcommand) => {
      const run = runCli(subcommand);

      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        `The ${subcommand} command lives in the skill now: run /git-agents ${subcommand} inside your coding agent.`,
      );
    },
  );

  it("still rejects an unknown argument", () => {
    const run = runCli("harnesses");

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Unknown argument: harnesses");
  });
});
