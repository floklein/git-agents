import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessPaths, readHarnessSet } from "../src/utils/harnessSet";
import { HARNESS_DECLARATIONS_FILE } from "../src/utils/harnessDeclarations";
import { AGENT_DEFS } from "../src/utils/agentDefs";
import {
  CANONICAL_HARNESSES,
  GENERATED_TARGETS,
} from "../src/canonical/canonical";

const tempDirs: string[] = [];

function makeClone(declarations?: unknown): string {
  const dir = join(
    tmpdir(),
    `ga-harness-set-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  if (declarations !== undefined) {
    writeFileSync(
      join(dir, HARNESS_DECLARATIONS_FILE),
      typeof declarations === "string"
        ? declarations
        : JSON.stringify(declarations),
      "utf8",
    );
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

// The five built-ins as the spec writes them in the declaration shape.
const BUILT_INS = [
  {
    id: "claude-code",
    name: "Claude Code",
    builtIn: true,
    overlayId: "claude",
    instructionsFile: ".claude/CLAUDE.md",
    syncPaths: [".claude/agents", ".claude/rules", ".claude/skills", ".claude/commands"],
  },
  {
    id: "codex",
    name: "Codex",
    builtIn: true,
    overlayId: "codex",
    instructionsFile: ".codex/AGENTS.md",
    syncPaths: [".codex/agents", ".agents/skills"],
  },
  {
    id: "cursor",
    name: "Cursor",
    builtIn: true,
    overlayId: "cursor",
    syncPaths: [".cursor/agents", ".cursor/skills", ".cursor/commands"],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    builtIn: true,
    overlayId: "gemini",
    instructionsFile: ".gemini/GEMINI.md",
    syncPaths: [".gemini/agents", ".gemini/commands", ".gemini/skills"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    builtIn: true,
    overlayId: "opencode",
    instructionsFile: ".config/opencode/AGENTS.md",
    syncPaths: [
      ".config/opencode/agents",
      ".config/opencode/commands",
      ".config/opencode/skills",
    ],
  },
];

describe("readHarnessSet", () => {
  it("is the five built-ins in the declaration shape when nothing is declared", () => {
    expect(readHarnessSet(makeClone())).toEqual({
      ok: true,
      harnesses: BUILT_INS,
    });
  });

  it("appends the declared harnesses after the built-ins, sorted by id", () => {
    const clone = makeClone({
      version: 1,
      harnesses: {
        zed: { syncPaths: [".zed/prompts"] },
        dsh: {
          name: "DeepSeek Harness",
          instructionsFile: ".dsh/AGENTS.md",
          syncPaths: [".dsh/skills"],
        },
      },
    });

    expect(readHarnessSet(clone)).toEqual({
      ok: true,
      harnesses: [
        ...BUILT_INS,
        {
          id: "dsh",
          name: "DeepSeek Harness",
          builtIn: false,
          overlayId: "dsh",
          instructionsFile: ".dsh/AGENTS.md",
          syncPaths: [".dsh/skills"],
        },
        {
          id: "zed",
          name: "zed",
          builtIn: false,
          overlayId: "zed",
          syncPaths: [".zed/prompts"],
        },
      ],
    });
  });

  it("treats an empty harnesses object like an absent file", () => {
    expect(readHarnessSet(makeClone({ version: 1, harnesses: {} }))).toEqual(
      readHarnessSet(makeClone()),
    );
  });

  it("yields the problems and no set at all when the file is invalid", () => {
    const clone = makeClone({
      version: 1,
      harnesses: {
        dsh: { syncPaths: [".dsh/skills"] },
        bad: { syncPaths: [".ssh/keys"] },
      },
    });

    const set = readHarnessSet(clone);

    expect(set.ok).toBe(false);
    if (set.ok) return;
    expect(set.problems.map((problem) => problem.code)).toEqual([
      "path-denylisted",
    ]);
    expect(set).not.toHaveProperty("harnesses");
  });

  it("reports malformed JSON as a problem, never as nothing declared", () => {
    const set = readHarnessSet(makeClone("{ not json"));

    expect(set.ok).toBe(false);
    if (set.ok) return;
    expect(set.problems.map((problem) => problem.code)).toEqual([
      "malformed-json",
    ]);
  });
});

describe("harnessPaths", () => {
  it("lists a custom harness's instructions file ahead of its sync paths", () => {
    const clone = makeClone({
      version: 1,
      harnesses: {
        dsh: { instructionsFile: ".dsh/AGENTS.md", syncPaths: [".dsh/skills"] },
      },
    });
    const set = readHarnessSet(clone);
    if (!set.ok) throw new Error("unreachable");

    expect(harnessPaths(set.harnesses.at(-1)!)).toEqual([
      ".dsh/AGENTS.md",
      ".dsh/skills",
    ]);
  });

  it("gives the built-ins exactly the paths, in the order, transport always used", () => {
    const set = readHarnessSet(makeClone());
    if (!set.ok) throw new Error("unreachable");

    expect(set.harnesses.map((harness) => harnessPaths(harness))).toEqual(
      AGENT_DEFS.map((def) => def.syncPaths),
    );
  });
});

describe("built-in harnesses", () => {
  it("agree with the canonical module on overlay ids and instructions files", () => {
    const set = readHarnessSet(makeClone());
    if (!set.ok) throw new Error("unreachable");

    expect(set.harnesses.map((harness) => harness.overlayId).sort()).toEqual(
      [...CANONICAL_HARNESSES].sort(),
    );
    expect(
      set.harnesses
        .filter((harness) => harness.instructionsFile !== undefined)
        .map((harness) => ({
          harness: harness.overlayId,
          syncPath: harness.instructionsFile,
        })),
    ).toEqual(GENERATED_TARGETS);
  });
});
