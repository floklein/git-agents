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

/**
 * What convergence knows of each built-in beyond its definition: the second id
 * it answers to for overlays, `harness=` markers and manifest keys, and which
 * of its sync paths is its instructions file. Cursor has no global
 * instructions file, so it receives no generated copy; its overlay is read
 * only through the opt-in pointer rule.
 *
 * Listed in canonical order, the fixed order built-in overlays are hashed,
 * listed and recorded in. This is the one table of these facts: the harness
 * set, the declarations validator and the canonical module derive theirs from
 * it.
 */
export const BUILT_IN_CONVERGENCE = [
  { harness: "claude-code", overlayId: "claude", instructionsFile: ".claude/CLAUDE.md" },
  { harness: "codex", overlayId: "codex", instructionsFile: ".codex/AGENTS.md" },
  { harness: "gemini-cli", overlayId: "gemini", instructionsFile: ".gemini/GEMINI.md" },
  { harness: "opencode", overlayId: "opencode", instructionsFile: ".config/opencode/AGENTS.md" },
  { harness: "cursor", overlayId: "cursor" },
] as const satisfies readonly {
  harness: string;
  overlayId: string;
  instructionsFile?: string;
}[];
