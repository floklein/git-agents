import { join, relative } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { ConfigSchema, type Config } from "../types";

export const CONFIG_DIR = join(homedir(), ".git-agents");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function readConfig(configFile: string = CONFIG_FILE): Config | null {
  try {
    if (!existsSync(configFile)) return null;
    const text = readFileSync(configFile, "utf8");
    const result = ConfigSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function writeConfig(
  config: Config,
  configDir: string = CONFIG_DIR,
  configFile: string = CONFIG_FILE,
): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");
}

export function getSyncDirForAgent(globalPath: string): string {
  const rel = relative(homedir(), globalPath);
  return join(CONFIG_DIR, rel);
}
