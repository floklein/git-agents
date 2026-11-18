import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runInternalCommand } from "../src/internal/commands";

// The subcommand surface is hand-maintained in several places: the skill
// frontmatter description, the router prose, the CLI usage and hint lists,
// and the README table. This list is the one place a new subcommand gets
// added; each assertion below fails on any surface that lags behind.
const SURFACE = ["setup", "sync", "sync unify", "edit", "harness", "status"];
const FIRST_WORDS = [
  ...new Set(SURFACE.map((s) => s.replace(/ .*/, ""))),
];

function read(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

describe("subcommand surface", () => {
  it("matches the skill frontmatter description", () => {
    expect(read("skills/git-agents/SKILL.md")).toContain(
      `Subcommands: ${SURFACE.join(", ")}.`,
    );
  });

  it("matches the router's first-word list", () => {
    const router = read("skills/git-agents/SKILL.md").match(
      /^The first word of the arguments selects the subcommand: .*$/m,
    )?.[0];
    expect(router).toBeDefined();
    for (const word of FIRST_WORDS) {
      expect(router).toContain(`\`${word}\``);
    }
  });

  it("matches the CLI usage line and skill hint list", () => {
    const index = read("src/index.ts");
    expect(index).toContain(`/git-agents ${SURFACE.join(" | ")}`);

    const hintList = index.match(/SKILL_SUBCOMMANDS = \[([^\]]*)\]/)?.[1] ?? "";
    const hintWords = [...hintList.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(hintWords).toEqual(FIRST_WORDS);
  });

  it("matches the README subcommand table", () => {
    const readme = read("README.md");
    for (const sub of SURFACE) {
      expect(readme).toContain(`| \`/git-agents ${sub}`);
    }
  });
});

describe("skill command table", () => {
  it("lists exactly the registered internal commands", async () => {
    // The unknown-command error is the one public listing of the registry.
    const outcome = await runInternalCommand("no-such-command", undefined, {
      homeDir: "unused",
      configDir: "unused",
      configFile: "unused",
    });
    expect(outcome.ok).toBe(false);
    const message = outcome.ok ? "" : outcome.error.message;
    const registered = (message.match(/Known commands: (.*)$/)?.[1] ?? "")
      .split(", ")
      .sort();

    const tabled = [
      ...read("skills/git-agents/SKILL.md").matchAll(/^\| `([a-z-]+)` \|/gm),
    ]
      .map((m) => m[1])
      .sort();

    expect(registered).toContain("harness-stage");
    expect(tabled).toEqual(registered);
  });
});
