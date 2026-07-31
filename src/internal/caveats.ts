import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InternalDeps } from "./commands";

const CODEX_CAP_BYTES = 32 * 1024;
const CODEX_NEAR_CAP_BYTES = 28 * 1024;
const GEMINI_DEFAULT_CONTEXT = "GEMINI.md";

export type Caveat = {
  code:
    | "codex-override-shadow"
    | "gemini-context-filename"
    | "codex-size-near-cap"
    | "codex-size-over-cap";
  message: string;
  path?: string;
  bytes?: number;
};

function geminiContextFileNames(settingsPath: string): string[] | null {
  if (!existsSync(settingsPath)) return null;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const fileName = settings?.context?.fileName;
    if (typeof fileName === "string") return [fileName];
    if (
      Array.isArray(fileName) &&
      fileName.every((name) => typeof name === "string")
    ) {
      return fileName;
    }
    return null;
  } catch {
    return null;
  }
}

export function detectCaveats(deps: InternalDeps): Caveat[] {
  const caveats: Caveat[] = [];

  const overridePath = join(deps.homeDir, ".codex", "AGENTS.override.md");
  if (existsSync(overridePath)) {
    caveats.push({
      code: "codex-override-shadow",
      message:
        "~/.codex/AGENTS.override.md exists and silently shadows the generated ~/.codex/AGENTS.md. Codex will not read the synced instructions until it is removed or merged.",
      path: overridePath,
    });
  }

  const geminiSettings = join(deps.homeDir, ".gemini", "settings.json");
  const contextNames = geminiContextFileNames(geminiSettings);
  if (contextNames !== null && !contextNames.includes(GEMINI_DEFAULT_CONTEXT)) {
    caveats.push({
      code: "gemini-context-filename",
      message:
        `Gemini CLI context.fileName is set to [${contextNames.join(", ")}], which does not include ${GEMINI_DEFAULT_CONTEXT}. ` +
        "The generated ~/.gemini/GEMINI.md will not be read until the setting includes it.",
      path: geminiSettings,
    });
  }

  const codexAgents = join(deps.homeDir, ".codex", "AGENTS.md");
  if (existsSync(codexAgents)) {
    const bytes = statSync(codexAgents).size;
    if (bytes >= CODEX_CAP_BYTES) {
      caveats.push({
        code: "codex-size-over-cap",
        message: `~/.codex/AGENTS.md is ${bytes} bytes, at or over Codex's 32 KiB cap. Codex silently truncates instruction docs at the cap.`,
        path: codexAgents,
        bytes,
      });
    } else if (bytes >= CODEX_NEAR_CAP_BYTES) {
      caveats.push({
        code: "codex-size-near-cap",
        message: `~/.codex/AGENTS.md is ${bytes} bytes, approaching Codex's 32 KiB cap (silent truncation at the cap).`,
        path: codexAgents,
        bytes,
      });
    }
  }

  return caveats;
}
