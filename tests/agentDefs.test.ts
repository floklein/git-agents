import { describe, expect, it } from "vitest";
import { isAbsolute } from "path";
import { AGENT_DEFS } from "../src/utils/agentDefs";

const EXPECTED_MANIFESTS = [
  {
    id: "claude-code",
    name: "Claude Code",
    syncPaths: [
      ".claude/CLAUDE.md",
      ".claude/agents",
      ".claude/rules",
      ".claude/skills",
      ".claude/commands",
    ],
  },
  {
    id: "codex",
    name: "Codex",
    syncPaths: [
      ".codex/AGENTS.md",
      ".codex/agents",
      ".agents/skills",
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    syncPaths: [
      ".cursor/agents",
      ".cursor/rules",
      ".cursor/skills",
      ".cursor/commands",
    ],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    syncPaths: [
      ".gemini/GEMINI.md",
      ".gemini/agents",
      ".gemini/commands",
      ".gemini/skills",
    ],
  },
  {
    id: "opencode",
    name: "OpenCode",
    syncPaths: [
      ".config/opencode/AGENTS.md",
      ".config/opencode/agents",
      ".config/opencode/commands",
      ".config/opencode/skills",
    ],
  },
];

describe("AGENT_DEFS", () => {
  it("contains exactly the five supported harness manifests", () => {
    expect(AGENT_DEFS).toEqual(EXPECTED_MANIFESTS);
    expect(AGENT_DEFS.map((def) => def.id)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "gemini-cli",
      "opencode",
    ]);
  });

  it("uses unique harness ids and sync paths", () => {
    const ids = AGENT_DEFS.map((def) => def.id);
    const syncPaths = AGENT_DEFS.flatMap((def) => def.syncPaths);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(syncPaths).size).toBe(syncPaths.length);
  });

  it("uses safe relative forward-slash sync paths", () => {
    for (const def of AGENT_DEFS) {
      expect(def.id.trim()).not.toBe("");
      expect(def.name.trim()).not.toBe("");
      expect(def.syncPaths.length).toBeGreaterThan(0);

      for (const syncPath of def.syncPaths) {
        const segments = syncPath.split("/");

        expect(syncPath.trim()).toBe(syncPath);
        expect(syncPath).not.toContain("\\");
        expect(isAbsolute(syncPath)).toBe(false);
        expect(syncPath).not.toMatch(/^[A-Za-z]:\//);
        expect(segments).not.toContain("");
        expect(segments).not.toContain("..");
      }
    }
  });
});
