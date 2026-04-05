import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { readConfig, writeConfig, getSyncDirForAgent, CONFIG_DIR } from "../src/utils/config";

let tmpDirs: string[] = [];

function useTmpConfig() {
  const dir = join(tmpdir(), `ga-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.json");
  tmpDirs.push(dir);
  return { dir, file };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("readConfig", () => {
  it("returns null when config file does not exist", () => {
    const { file } = useTmpConfig();
    expect(readConfig(file)).toBeNull();
  });

  it("returns parsed config when file is valid JSON", () => {
    const { dir, file } = useTmpConfig();
    writeFileSync(file, JSON.stringify({ remote: "gh" }), "utf8");

    const config = readConfig(file);
    expect(config).toEqual({ remote: "gh" });
  });

  it("returns config with repoUrl for git remote type", () => {
    const { file } = useTmpConfig();
    writeFileSync(file, JSON.stringify({ remote: "git", repoUrl: "git@github.com:user/repo.git" }), "utf8");

    const config = readConfig(file);
    expect(config).toEqual({ remote: "git", repoUrl: "git@github.com:user/repo.git" });
  });

  it("returns null on malformed JSON", () => {
    const { file } = useTmpConfig();
    writeFileSync(file, "not valid json {{{", "utf8");

    expect(readConfig(file)).toBeNull();
  });

  it("returns null for invalid remote value", () => {
    const { file } = useTmpConfig();
    writeFileSync(file, JSON.stringify({ remote: "ftp" }), "utf8");

    expect(readConfig(file)).toBeNull();
  });

  it("returns null when remote field is missing", () => {
    const { file } = useTmpConfig();
    writeFileSync(file, JSON.stringify({ repoUrl: "git@github.com:user/repo.git" }), "utf8");

    expect(readConfig(file)).toBeNull();
  });
});

describe("writeConfig", () => {
  it("writes config as formatted JSON", () => {
    const { dir, file } = useTmpConfig();
    writeConfig({ remote: "gh" }, dir, file);

    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written).toEqual({ remote: "gh" });
  });

  it("round-trips: written config can be read back", () => {
    const { dir, file } = useTmpConfig();
    const config = { remote: "git" as const, repoUrl: "git@github.com:user/repo.git" };
    writeConfig(config, dir, file);

    expect(readConfig(file)).toEqual(config);
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
