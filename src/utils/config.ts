import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { Config } from "../types";

export const CONFIG_DIR = join(homedir(), ".git-agents");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const AGENTS_SYNC_DIR = join(CONFIG_DIR, ".agents");
export const AGENTS_LOCAL_DIR = join(homedir(), ".agents");

export function readConfig(): Config | null {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    const text = readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(text) as Config;
  } catch {
    return null;
  }
}

export function writeConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}
