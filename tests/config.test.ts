import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readConfig,
  writeConfig,
  resolveSyncPath,
  getLocalSyncPath,
  getRemoteSyncPath,
} from "../src/utils/config";

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

describe("resolveSyncPath", () => {
  it("maps forward-slash nested paths under the provided base", () => {
    const { dir } = useTmpConfig();

    expect(resolveSyncPath(dir, ".config/opencode/skills")).toBe(
      join(dir, ".config", "opencode", "skills"),
    );
  });

  it("maps Windows-style nested separators safely", () => {
    const { dir } = useTmpConfig();

    expect(resolveSyncPath(dir, ".gemini\\commands\\review")).toBe(
      join(dir, ".gemini", "commands", "review"),
    );
  });

  it("rejects absolute paths", () => {
    const { dir } = useTmpConfig();

    expect(() => resolveSyncPath(dir, join(dir, ".claude", "skills"))).toThrow();
    expect(() => resolveSyncPath(dir, "/outside/skills")).toThrow();
  });

  it("rejects traversal paths", () => {
    const { dir } = useTmpConfig();

    expect(() => resolveSyncPath(dir, "../outside")).toThrow();
    expect(() => resolveSyncPath(dir, ".claude/../../outside")).toThrow();
    expect(() => resolveSyncPath(dir, ".claude\\..\\outside")).toThrow();
  });

  it("rejects empty and malformed paths", () => {
    const { dir } = useTmpConfig();

    expect(() => resolveSyncPath(dir, "")).toThrow();
    expect(() => resolveSyncPath(dir, "   ")).toThrow();
    expect(() => resolveSyncPath(dir, ".claude//skills")).toThrow();
  });
});

describe("getLocalSyncPath", () => {
  it("resolves a manifest path under the selected home directory", () => {
    const { dir } = useTmpConfig();

    expect(getLocalSyncPath(".claude/CLAUDE.md", dir)).toBe(
      join(dir, ".claude", "CLAUDE.md"),
    );
  });
});

describe("getRemoteSyncPath", () => {
  it("preserves the home-relative layout under the sync repository", () => {
    const { dir } = useTmpConfig();

    expect(getRemoteSyncPath(".agents/skills", dir)).toBe(
      join(dir, ".agents", "skills"),
    );
  });
});
