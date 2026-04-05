import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { tmpdir } from "os";
import { readConfig, writeConfig, getSyncDirForAgent, CONFIG_DIR, CONFIG_FILE } from "../src/utils/config";

// Save and restore the real config file around each test
let savedConfig: string | null = null;

beforeEach(() => {
  savedConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : null;
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE);
});

afterEach(() => {
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE);
  if (savedConfig !== null) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, savedConfig, "utf8");
  }
  savedConfig = null;
});

describe("readConfig", () => {
  it("returns null when config file does not exist", () => {
    expect(readConfig()).toBeNull();
  });

  it("returns parsed config when file is valid JSON", () => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ remote: "gh" }), "utf8");

    const config = readConfig();
    expect(config).toEqual({ remote: "gh" });
  });

  it("returns config with repoUrl for git remote type", () => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ remote: "git", repoUrl: "git@github.com:user/repo.git" }), "utf8");

    const config = readConfig();
    expect(config).toEqual({ remote: "git", repoUrl: "git@github.com:user/repo.git" });
  });

  it("returns null on malformed JSON", () => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, "not valid json {{{", "utf8");

    expect(readConfig()).toBeNull();
  });
});

describe("writeConfig", () => {
  it("writes config as formatted JSON", () => {
    writeConfig({ remote: "gh" });

    expect(existsSync(CONFIG_FILE)).toBe(true);
    const written = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    expect(written).toEqual({ remote: "gh" });
  });

  it("round-trips: written config can be read back", () => {
    const config = { remote: "git" as const, repoUrl: "git@github.com:user/repo.git" };
    writeConfig(config);

    expect(readConfig()).toEqual(config);
  });
});

describe("getSyncDirForAgent", () => {
  it("returns path under CONFIG_DIR relative to homedir", () => {
    const agentPath = join(homedir(), ".claude");
    const result = getSyncDirForAgent(agentPath);
    expect(result).toBe(join(CONFIG_DIR, ".claude"));
  });

  it("preserves nested paths", () => {
    const agentPath = join(homedir(), ".config", "agents");
    const result = getSyncDirForAgent(agentPath);
    expect(result).toBe(join(CONFIG_DIR, ".config", "agents"));
  });
});
