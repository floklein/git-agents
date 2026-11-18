import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runInternalCommand,
  type InternalDeps,
} from "../src/internal/commands";
import type {
  HarnessApplyResult,
  HarnessStageResult,
} from "../src/internal/harnessCommands";

// Keep temp-repo commits independent of the host's global git config.
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "commit.gpgsign";
process.env.GIT_CONFIG_VALUE_0 = "false";

const DECLARATIONS_FILE = ".git-agents-harnesses.json";
const STAGE_FILE = ".git-agents-harness-stage.json";

const DSH = {
  name: "DeepSeek Harness",
  instructionsFile: ".dsh/AGENTS.md",
  syncPaths: [".dsh/skills"],
};

const DSH_FILE_TEXT = `{
  "version": 1,
  "harnesses": {
    "dsh": {
      "name": "DeepSeek Harness",
      "instructionsFile": ".dsh/AGENTS.md",
      "syncPaths": [
        ".dsh/skills"
      ]
    }
  }
}
`;

const tempDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

// A machine with a sync repo clone and a home directory.
function makeDeps(): InternalDeps {
  const homeDir = makeTmpDir("ga-harness-home");
  const configDir = makeTmpDir("ga-harness-clone");
  execFileSync("git", ["init", "-b", "main", configDir], { stdio: "ignore" });
  return { homeDir, configDir, configFile: join(configDir, "config.json") };
}

function writeHome(deps: InternalDeps, relPath: string, content: string): void {
  const target = join(deps.homeDir, ...relPath.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function declarationsPath(deps: InternalDeps): string {
  return join(deps.configDir, DECLARATIONS_FILE);
}

function writeDeclarations(deps: InternalDeps, text: string): void {
  writeFileSync(declarationsPath(deps), text, "utf8");
}

async function stage(
  deps: InternalDeps,
  input: unknown,
): Promise<HarnessStageResult> {
  const outcome = await runInternalCommand("harness-stage", input, deps);
  if (!outcome.ok) throw new Error(`harness-stage failed: ${outcome.error.message}`);
  return outcome.result as HarnessStageResult;
}

async function apply(deps: InternalDeps): Promise<HarnessApplyResult> {
  const outcome = await runInternalCommand("harness-apply", undefined, deps);
  if (!outcome.ok) throw new Error(`harness-apply failed: ${outcome.error.message}`);
  return outcome.result as HarnessApplyResult;
}

async function refusal(
  command: string,
  input: unknown,
  deps: InternalDeps,
): Promise<{ code: string; message: string }> {
  const outcome = await runInternalCommand(command, input, deps);
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("unreachable");
  return outcome.error;
}

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  tempDirs.length = 0;
});

describe("harness-stage", () => {
  it("renders the exact file diff and the paths that start syncing", async () => {
    const deps = makeDeps();
    writeHome(deps, ".dsh/AGENTS.md", "12345");
    writeHome(deps, ".dsh/skills/review/SKILL.md", "1234567");
    writeHome(deps, ".dsh/skills/notes.txt", "123");

    const result = await stage(deps, { harnesses: { dsh: DSH } });

    expect(result.file).toEqual({
      path: DECLARATIONS_FILE,
      changed: true,
      diff:
        `--- a/${DECLARATIONS_FILE}\n+++ b/${DECLARATIONS_FILE}\n@@ -0,0 +1,12 @@\n` +
        DSH_FILE_TEXT.split("\n")
          .slice(0, -1)
          .map((line) => `+${line}\n`)
          .join(""),
    });
    expect(result.startSyncing).toEqual([
      {
        harness: "dsh",
        field: "instructionsFile",
        path: ".dsh/AGENTS.md",
        present: true,
        fileCount: 1,
        totalBytes: 5,
      },
      {
        harness: "dsh",
        field: "syncPaths",
        path: ".dsh/skills",
        present: true,
        fileCount: 2,
        totalBytes: 10,
      },
    ]);
    expect(result.stopSyncing).toEqual([]);
    // Staging previews; the declarations file is not written yet.
    expect(existsSync(declarationsPath(deps))).toBe(false);
  });

  it("rejects an invalid proposal with every problem and writes nothing", async () => {
    const deps = makeDeps();
    const before = readdirSync(deps.configDir).sort();

    const error = await refusal(
      "harness-stage",
      {
        harnesses: {
          claude: { syncPaths: [".claude2/skills"] },
          dsh: { instructionsFile: ".ssh/AGENTS.md", syncPaths: [".dsh"] },
          empty: {},
        },
      },
      deps,
    );

    expect(error.code).toBe("invalid-harness-proposal");
    expect(error.message).toContain(
      'harness "claude": this id belongs to a built-in harness',
    );
    expect(error.message).toContain(
      '".ssh/AGENTS.md" is in the credential location ".ssh"',
    );
    expect(error.message).toContain('".dsh" sits at the home root');
    expect(error.message).toContain('harness "empty": declare at least one of');
    expect(readdirSync(deps.configDir).sort()).toEqual(before);
  });

  it("refuses a proposal that is not an object", async () => {
    const deps = makeDeps();

    const error = await refusal("harness-stage", undefined, deps);

    expect(error.code).toBe("invalid-input");
    expect(existsSync(join(deps.configDir, STAGE_FILE))).toBe(false);
  });

  it("refuses a version other than the one the scripts write", async () => {
    const deps = makeDeps();

    const error = await refusal(
      "harness-stage",
      { version: 2, harnesses: { dsh: DSH } },
      deps,
    );

    expect(error.code).toBe("invalid-harness-proposal");
    expect(error.message).toContain('"version" 2 is not supported');
  });

  it("refuses without a sync repo", async () => {
    const homeDir = makeTmpDir("ga-harness-home");
    const configDir = join(makeTmpDir("ga-harness-noclone"), "missing");
    const deps = { homeDir, configDir, configFile: join(configDir, "config.json") };

    const error = await refusal("harness-stage", { harnesses: { dsh: DSH } }, deps);

    expect(error.code).toBe("not-configured");
    expect(existsSync(configDir)).toBe(false);
  });

  it("refuses to replace something that is not a regular file", async () => {
    const deps = makeDeps();
    mkdirSync(declarationsPath(deps));

    const error = await refusal("harness-stage", { harnesses: { dsh: DSH } }, deps);

    expect(error.code).toBe("harness-file-not-regular");
    expect(error.message).toContain(declarationsPath(deps));
    expect(existsSync(join(deps.configDir, STAGE_FILE))).toBe(false);
  });

  it("shows a name change as a diff with no path starting or stopping", async () => {
    const deps = makeDeps();
    writeDeclarations(deps, DSH_FILE_TEXT);

    const result = await stage(deps, {
      harnesses: { dsh: { ...DSH, name: "DSH" } },
    });

    expect(result.file.changed).toBe(true);
    expect(result.file.diff).toContain(
      '-      "name": "DeepSeek Harness",\n+      "name": "DSH",\n',
    );
    expect(result.startSyncing).toEqual([]);
    expect(result.stopSyncing).toEqual([]);
    expect(result.currentProblems).toEqual([]);
  });

  it("reports no change when the proposal is the current file", async () => {
    const deps = makeDeps();
    // A CRLF checkout of the same file is not a content change.
    writeDeclarations(deps, DSH_FILE_TEXT.replace(/\n/g, "\r\n"));

    const result = await stage(deps, { harnesses: { dsh: DSH } });

    expect(result.file).toEqual({
      path: DECLARATIONS_FILE,
      changed: false,
      diff: "",
    });
    expect(result.startSyncing).toEqual([]);
    expect(result.stopSyncing).toEqual([]);
  });

  it("lists only the added path when a declared harness gains one", async () => {
    const deps = makeDeps();
    writeDeclarations(deps, DSH_FILE_TEXT);
    writeHome(deps, ".dsh/skills/review/SKILL.md", "already syncing");

    const result = await stage(deps, {
      harnesses: {
        dsh: { ...DSH, syncPaths: [".dsh/skills", ".dsh/commands"] },
      },
    });

    expect(result.startSyncing).toEqual([
      {
        harness: "dsh",
        field: "syncPaths",
        path: ".dsh/commands",
        present: false,
        fileCount: 0,
        totalBytes: 0,
      },
    ]);
    expect(result.stopSyncing).toEqual([]);
  });

  it("lists the paths that stop syncing when a proposal drops them", async () => {
    const deps = makeDeps();
    writeDeclarations(deps, DSH_FILE_TEXT);

    const result = await stage(deps, {
      harnesses: { zed: { syncPaths: [".zed/prompts"] } },
    });

    expect(result.stopSyncing).toEqual([
      { harness: "dsh", field: "instructionsFile", path: ".dsh/AGENTS.md" },
      { harness: "dsh", field: "syncPaths", path: ".dsh/skills" },
    ]);
    expect(result.startSyncing.map((entry) => entry.path)).toEqual([
      ".zed/prompts",
    ]);
  });

  it("appears with harness-apply in the unknown-command help list", async () => {
    const error = await refusal("nope", undefined, makeDeps());

    expect(error.message).toContain("harness-stage");
    expect(error.message).toContain("harness-apply");
  });
});

describe("harness-apply", () => {
  it("writes the file exactly as staged, with version 1", async () => {
    const deps = makeDeps();
    // Field and id order in the proposal do not change the file.
    await stage(deps, {
      harnesses: {
        zed: { syncPaths: [".zed/prompts"] },
        dsh: {
          syncPaths: [".dsh/skills"],
          instructionsFile: ".dsh/AGENTS.md",
          name: "DeepSeek Harness",
        },
      },
    });

    const result = await apply(deps);

    expect(result).toEqual({ path: DECLARATIONS_FILE, written: true });
    expect(readFileSync(declarationsPath(deps), "utf8")).toBe(`{
  "version": 1,
  "harnesses": {
    "dsh": {
      "name": "DeepSeek Harness",
      "instructionsFile": ".dsh/AGENTS.md",
      "syncPaths": [
        ".dsh/skills"
      ]
    },
    "zed": {
      "syncPaths": [
        ".zed/prompts"
      ]
    }
  }
}
`);
    expect(existsSync(join(deps.configDir, STAGE_FILE))).toBe(false);
  });

  it("refuses when nothing is staged", async () => {
    const deps = makeDeps();

    const error = await refusal("harness-apply", undefined, deps);

    expect(error.code).toBe("no-harness-stage");
    expect(existsSync(declarationsPath(deps))).toBe(false);
  });

  it("refuses when the file changed since staging", async () => {
    const deps = makeDeps();
    writeDeclarations(deps, DSH_FILE_TEXT);
    await stage(deps, { harnesses: { dsh: { ...DSH, name: "DSH" } } });
    const edited = DSH_FILE_TEXT.replace("DeepSeek Harness", "Edited By Hand");
    writeDeclarations(deps, edited);

    const error = await refusal("harness-apply", undefined, deps);

    expect(error.code).toBe("stale-harness-stage");
    expect(readFileSync(declarationsPath(deps), "utf8")).toBe(edited);
  });

  it("refuses when the file appeared since staging", async () => {
    const deps = makeDeps();
    await stage(deps, { harnesses: { dsh: DSH } });
    const pulled = DSH_FILE_TEXT.replace("DeepSeek Harness", "Pulled");
    writeDeclarations(deps, pulled);

    const error = await refusal("harness-apply", undefined, deps);

    expect(error.code).toBe("stale-harness-stage");
    expect(readFileSync(declarationsPath(deps), "utf8")).toBe(pulled);
  });

  it("refuses a staged state it cannot read", async () => {
    const deps = makeDeps();
    writeFileSync(join(deps.configDir, STAGE_FILE), "{ not json", "utf8");

    const error = await refusal("harness-apply", undefined, deps);

    expect(error.code).toBe("invalid-harness-stage");
    expect(existsSync(declarationsPath(deps))).toBe(false);
  });

  it("repairs an invalid current file", async () => {
    const deps = makeDeps();
    writeDeclarations(
      deps,
      '{ "version": 1, "harnesses": { "dsh": { "syncPaths": [".ssh/keys"] } }',
    );

    const staged = await stage(deps, { harnesses: { dsh: DSH } });
    expect(staged.currentProblems.map((problem) => problem.code)).toEqual([
      "malformed-json",
    ]);
    expect(staged.file.changed).toBe(true);
    // An invalid file declares nothing, so every proposed path starts.
    expect(staged.startSyncing.map((entry) => entry.path)).toEqual([
      ".dsh/AGENTS.md",
      ".dsh/skills",
    ]);
    await apply(deps);

    expect(readFileSync(declarationsPath(deps), "utf8")).toBe(DSH_FILE_TEXT);
    const status = await runInternalCommand("status", undefined, deps);
    expect(status.ok).toBe(true);
    if (status.ok) {
      const report = status.result as {
        harnesses: { id: string }[];
        caveats: { code: string }[];
      };
      expect(report.harnesses.map((harness) => harness.id)).toContain("dsh");
      expect(report.caveats.map((caveat) => caveat.code)).not.toContain(
        "invalid-harness-declarations",
      );
    }
  });

  it("creates no file for an empty set when none exists", async () => {
    const deps = makeDeps();

    const staged = await stage(deps, { harnesses: {} });
    expect(staged.file).toEqual({
      path: DECLARATIONS_FILE,
      changed: false,
      diff: "",
    });
    const result = await apply(deps);

    expect(result).toEqual({ path: DECLARATIONS_FILE, written: false });
    expect(existsSync(declarationsPath(deps))).toBe(false);
    expect(existsSync(join(deps.configDir, STAGE_FILE))).toBe(false);
  });

  it("writes an empty set over existing declarations and deletes nothing else", async () => {
    const deps = makeDeps();
    writeDeclarations(deps, DSH_FILE_TEXT);
    writeHome(deps, ".dsh/AGENTS.md", "home copy");
    mkdirSync(join(deps.configDir, ".dsh", "skills"), { recursive: true });
    writeFileSync(join(deps.configDir, ".dsh", "AGENTS.md"), "repo copy", "utf8");

    const staged = await stage(deps, { harnesses: {} });
    expect(staged.stopSyncing.map((entry) => entry.path)).toEqual([
      ".dsh/AGENTS.md",
      ".dsh/skills",
    ]);
    await apply(deps);

    expect(readFileSync(declarationsPath(deps), "utf8")).toBe(
      '{\n  "version": 1,\n  "harnesses": {}\n}\n',
    );
    expect(
      readFileSync(join(deps.configDir, ".dsh", "AGENTS.md"), "utf8"),
    ).toBe("repo copy");
    expect(existsSync(join(deps.configDir, ".dsh", "skills"))).toBe(true);
    expect(readFileSync(join(deps.homeDir, ".dsh", "AGENTS.md"), "utf8")).toBe(
      "home copy",
    );
  });

  it("leaves the home directory untouched", async () => {
    const deps = makeDeps();
    writeHome(deps, ".dsh/AGENTS.md", "home copy");

    await stage(deps, { harnesses: { dsh: DSH } });
    await apply(deps);

    expect(readdirSync(deps.homeDir)).toEqual([".dsh"]);
    expect(readdirSync(join(deps.homeDir, ".dsh"))).toEqual(["AGENTS.md"]);
  });

  it("keeps the staged state out of the sync commit", async () => {
    const bare = join(makeTmpDir("ga-harness-remote"), "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare], {
      stdio: "ignore",
    });
    const homeDir = makeTmpDir("ga-harness-home");
    const configDir = join(makeTmpDir("ga-harness-clone"), "clone");
    execFileSync("git", ["clone", bare, configDir], { stdio: "ignore" });
    execFileSync("git", ["-C", configDir, "checkout", "-B", "main"], {
      stdio: "ignore",
    });
    const deps = { homeDir, configDir, configFile: join(configDir, "config.json") };
    writeHome(deps, ".dsh/AGENTS.md", "dsh instructions\n");
    await stage(deps, { harnesses: { dsh: DSH } });
    await apply(deps);
    // A second proposal is left staged while the machine syncs.
    await stage(deps, { harnesses: { dsh: { ...DSH, name: "DSH" } } });

    const begin = await runInternalCommand("transport-begin", undefined, deps);
    expect(begin).toMatchObject({ ok: true, result: { state: "clean" } });
    const commit = await runInternalCommand("transport-commit", undefined, deps);
    expect(commit.ok).toBe(true);

    const committed = execFileSync(
      "git",
      ["-C", deps.configDir, "ls-tree", "-r", "--name-only", "HEAD"],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    expect(committed).toContain(DECLARATIONS_FILE);
    expect(committed).toContain(".dsh/AGENTS.md");
    expect(committed).not.toContain(STAGE_FILE);
    expect(existsSync(join(deps.configDir, STAGE_FILE))).toBe(true);
  }, 30000);
});
