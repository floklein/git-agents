import { isAbsolute, join, relative, resolve, sep } from "path";
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

export function resolveSyncPath(baseDir: string, syncPath: string): string {
  if (!syncPath.trim() || isAbsolute(syncPath)) {
    throw new Error(`Sync path must be relative: ${syncPath}`);
  }

  const segments = syncPath.split(/[\\/]/);
  if (segments.some((segment) => !segment || segment === "..")) {
    throw new Error(`Invalid sync path: ${syncPath}`);
  }

  const base = resolve(baseDir);
  const target = resolve(base, ...segments);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Sync path escapes its base directory: ${syncPath}`);
  }
  return target;
}

export function getLocalSyncPath(
  syncPath: string,
  homeDir: string = homedir(),
): string {
  return resolveSyncPath(homeDir, syncPath);
}

export function getRemoteSyncPath(
  syncPath: string,
  configDir: string = CONFIG_DIR,
): string {
  return resolveSyncPath(configDir, syncPath);
}
