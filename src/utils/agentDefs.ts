import { join } from "path";
import { homedir } from "os";

export type AgentDef = {
  id: string;
  name: string;
  globalPath: string;
};

const H = homedir();

export const AGENT_DEFS: AgentDef[] = [
  { id: "amp",           name: "Amp",            globalPath: join(H, ".config/agents") },
  { id: "kimi-cli",      name: "Kimi Code CLI",  globalPath: join(H, ".config/agents") },
  { id: "replit",        name: "Replit",         globalPath: join(H, ".config/agents") },
  { id: "universal",     name: "Universal",      globalPath: join(H, ".config/agents") },
  { id: "antigravity",   name: "Antigravity",    globalPath: join(H, ".gemini/antigravity") },
  { id: "augment",       name: "Augment",        globalPath: join(H, ".augment") },
  { id: "bob",           name: "IBM Bob",        globalPath: join(H, ".bob") },
  { id: "claude-code",   name: "Claude Code",    globalPath: join(H, ".claude") },
  { id: "openclaw",      name: "OpenClaw",       globalPath: join(H, ".openclaw") },
  { id: "cline",         name: "Cline",          globalPath: join(H, ".agents") },
  { id: "warp",          name: "Warp",           globalPath: join(H, ".agents") },
  { id: "codebuddy",     name: "CodeBuddy",      globalPath: join(H, ".codebuddy") },
  { id: "codex",         name: "Codex",          globalPath: join(H, ".codex") },
  { id: "command-code",  name: "Command Code",   globalPath: join(H, ".commandcode") },
  { id: "continue",      name: "Continue",       globalPath: join(H, ".continue") },
  { id: "cortex",        name: "Cortex Code",    globalPath: join(H, ".snowflake/cortex") },
  { id: "crush",         name: "Crush",          globalPath: join(H, ".config/crush") },
  { id: "cursor",        name: "Cursor",         globalPath: join(H, ".cursor") },
  { id: "deepagents",    name: "Deep Agents",    globalPath: join(H, ".deepagents/agent") },
  { id: "droid",         name: "Droid",          globalPath: join(H, ".factory") },
  { id: "firebender",    name: "Firebender",     globalPath: join(H, ".firebender") },
  { id: "gemini-cli",    name: "Gemini CLI",     globalPath: join(H, ".gemini") },
  { id: "github-copilot",name: "GitHub Copilot", globalPath: join(H, ".copilot") },
  { id: "goose",         name: "Goose",          globalPath: join(H, ".config/goose") },
  { id: "junie",         name: "Junie",          globalPath: join(H, ".junie") },
  { id: "iflow-cli",     name: "iFlow CLI",      globalPath: join(H, ".iflow") },
  { id: "kilo",          name: "Kilo Code",      globalPath: join(H, ".kilocode") },
  { id: "kiro-cli",      name: "Kiro CLI",       globalPath: join(H, ".kiro") },
  { id: "kode",          name: "Kode",           globalPath: join(H, ".kode") },
  { id: "mcpjam",        name: "MCPJam",         globalPath: join(H, ".mcpjam") },
  { id: "mistral-vibe",  name: "Mistral Vibe",   globalPath: join(H, ".vibe") },
  { id: "mux",           name: "Mux",            globalPath: join(H, ".mux") },
  { id: "opencode",      name: "OpenCode",       globalPath: join(H, ".config/opencode") },
  { id: "openhands",     name: "OpenHands",      globalPath: join(H, ".openhands") },
  { id: "pi",            name: "Pi",             globalPath: join(H, ".pi/agent") },
  { id: "qoder",         name: "Qoder",          globalPath: join(H, ".qoder") },
  { id: "qwen-code",     name: "Qwen Code",      globalPath: join(H, ".qwen") },
  { id: "roo",           name: "Roo Code",       globalPath: join(H, ".roo") },
  { id: "trae",          name: "Trae",           globalPath: join(H, ".trae") },
  { id: "trae-cn",       name: "Trae CN",        globalPath: join(H, ".trae-cn") },
  { id: "windsurf",      name: "Windsurf",       globalPath: join(H, ".codeium/windsurf") },
  { id: "zencoder",      name: "Zencoder",       globalPath: join(H, ".zencoder") },
  { id: "neovate",       name: "Neovate",        globalPath: join(H, ".neovate") },
  { id: "pochi",         name: "Pochi",          globalPath: join(H, ".pochi") },
  { id: "adal",          name: "AdaL",           globalPath: join(H, ".adal") },
];
