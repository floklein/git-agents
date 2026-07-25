export type AgentDef = {
  id: string;
  name: string;
  syncPaths: string[];
};

export const AGENT_DEFS: AgentDef[] = [
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
