import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { detectCaveats } from "../src/internal/caveats";
import type { InternalDeps } from "../src/internal/commands";

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeDeps(): InternalDeps {
  const homeDir = makeTmpDir("ga-caveats-home");
  const configDir = makeTmpDir("ga-caveats-config");
  return { homeDir, configDir, configFile: join(configDir, "config.json") };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("detectCaveats", () => {
  it("reports nothing on a clean machine", () => {
    expect(detectCaveats(makeDeps())).toEqual([]);
  });

  it("detects a Codex override file shadowing the generated one", () => {
    const deps = makeDeps();
    mkdirSync(join(deps.homeDir, ".codex"), { recursive: true });
    writeFileSync(
      join(deps.homeDir, ".codex", "AGENTS.override.md"),
      "# override\n",
      "utf8",
    );

    const caveats = detectCaveats(deps);

    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toMatchObject({
      code: "codex-override-shadow",
      path: join(deps.homeDir, ".codex", "AGENTS.override.md"),
    });
  });

  it("detects a Gemini context.fileName that excludes GEMINI.md", () => {
    const deps = makeDeps();
    mkdirSync(join(deps.homeDir, ".gemini"), { recursive: true });
    writeFileSync(
      join(deps.homeDir, ".gemini", "settings.json"),
      JSON.stringify({ context: { fileName: ["AGENTS.md", "CONTEXT.md"] } }),
      "utf8",
    );

    const caveats = detectCaveats(deps);

    expect(caveats).toHaveLength(1);
    expect(caveats[0]!.code).toBe("gemini-context-filename");
  });

  it("accepts Gemini settings that keep GEMINI.md in the list", () => {
    const deps = makeDeps();
    mkdirSync(join(deps.homeDir, ".gemini"), { recursive: true });
    writeFileSync(
      join(deps.homeDir, ".gemini", "settings.json"),
      JSON.stringify({ context: { fileName: ["AGENTS.md", "GEMINI.md"] } }),
      "utf8",
    );

    expect(detectCaveats(deps)).toEqual([]);
  });

  it("ignores unreadable or unrelated Gemini settings", () => {
    const deps = makeDeps();
    mkdirSync(join(deps.homeDir, ".gemini"), { recursive: true });
    writeFileSync(
      join(deps.homeDir, ".gemini", "settings.json"),
      "{not json",
      "utf8",
    );

    expect(detectCaveats(deps)).toEqual([]);
  });

  it("warns near and at the Codex 32 KiB cap", () => {
    const deps = makeDeps();
    mkdirSync(join(deps.homeDir, ".codex"), { recursive: true });
    const agents = join(deps.homeDir, ".codex", "AGENTS.md");

    writeFileSync(agents, "x".repeat(28 * 1024), "utf8");
    expect(detectCaveats(deps)[0]).toMatchObject({
      code: "codex-size-near-cap",
      bytes: 28 * 1024,
    });

    writeFileSync(agents, "x".repeat(33 * 1024), "utf8");
    expect(detectCaveats(deps)[0]).toMatchObject({
      code: "codex-size-over-cap",
      bytes: 33 * 1024,
    });

    writeFileSync(agents, "x".repeat(1024), "utf8");
    expect(detectCaveats(deps)).toEqual([]);
  });
});
