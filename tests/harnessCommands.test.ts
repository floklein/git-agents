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

// A file of the sync repo clone: a mirrored copy, an overlay, the core.
function writeClone(deps: InternalDeps, relPath: string, content: string): void {
  const target = join(deps.configDir, ...relPath.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
}

// Every file under a directory, by its path from there, with its content.
function readTree(root: string, prefix = ""): Record<string, string> {
  const tree: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relPath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(tree, readTree(join(root, entry.name), `${relPath}/`));
    } else {
      tree[relPath] = readFileSync(join(root, entry.name), "utf8");
    }
  }
  return tree;
}

type Manifest = {
  canonical: { version: string; core: string; overlays: Record<string, string> };
  generated: Record<string, { path: string; canonicalVersion: string }>;
};

function readManifest(deps: InternalDeps): Manifest {
  return JSON.parse(
    readFileSync(join(deps.configDir, ".git-agents-sync.json"), "utf8"),
  );
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

  it("previews a removal: the repo files and the overlay that go, and that home files stay", async () => {
    const deps = makeDeps();
    writeDeclarations(deps, DSH_FILE_TEXT);
    writeClone(deps, ".dsh/AGENTS.md", "repo copy");
    writeClone(deps, ".dsh/skills/review/SKILL.md", "review skill");
    writeClone(deps, ".dsh/skills/notes.txt", "notes");
    writeClone(deps, ".claude/CLAUDE.md", "not a dsh file");
    writeClone(deps, "canonical/core.md", "# Shared\n");
    writeClone(deps, "canonical/overlays/dsh.md", "# DSH only\n");
    writeClone(deps, "canonical/overlays/claude.md", "# Claude only\n");
    // The manifest entries of the harness, as a sync unify records them.
    expect((await runInternalCommand("propagate", undefined, deps)).ok).toBe(true);

    const result = await stage(deps, { harnesses: {} });

    expect(result.stopSyncing.map((entry) => entry.path)).toEqual([
      ".dsh/AGENTS.md",
      ".dsh/skills",
    ]);
    expect(result.removal).toEqual({
      harnesses: [{ harness: "dsh", name: "DeepSeek Harness" }],
      repoFiles: [
        ".dsh/AGENTS.md",
        ".dsh/skills/notes.txt",
        ".dsh/skills/review/SKILL.md",
      ],
      overlays: [
        {
          harness: "dsh",
          path: "canonical/overlays/dsh.md",
          content: "# DSH only\n",
        },
      ],
      manifest: { generated: ["dsh"], overlays: ["dsh"] },
      canonicalVersionChanges: true,
      homeFiles: expect.stringMatching(/home directory.*untouched.*every machine/),
    });
    // Staging previews; nothing is deleted yet.
    expect(existsSync(join(deps.configDir, ".dsh", "AGENTS.md"))).toBe(true);
    expect(
      existsSync(join(deps.configDir, "canonical", "overlays", "dsh.md")),
    ).toBe(true);
  });

  it("previews no removal when nothing stops syncing", async () => {
    const deps = makeDeps();
    writeDeclarations(deps, DSH_FILE_TEXT);
    writeClone(deps, ".dsh/AGENTS.md", "repo copy");

    const renamed = await stage(deps, {
      harnesses: { dsh: { ...DSH, name: "DSH" } },
    });
    const grown = await stage(deps, {
      harnesses: { dsh: DSH, zed: { syncPaths: [".zed/prompts"] } },
    });

    expect(renamed.removal).toBeUndefined();
    expect(grown.removal).toBeUndefined();
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

  it("writes an empty set over existing declarations and cleans the sync repo, never the home directory", async () => {
    const deps = makeDeps();
    writeDeclarations(deps, DSH_FILE_TEXT);
    writeClone(deps, ".dsh/AGENTS.md", "repo copy");
    writeClone(deps, ".dsh/skills/review/SKILL.md", "review skill");
    writeClone(deps, ".claude/CLAUDE.md", "not a dsh file");
    writeClone(deps, "canonical/core.md", "# Shared\n");
    writeClone(deps, "canonical/overlays/dsh.md", "# DSH only\n");
    writeClone(deps, "canonical/overlays/claude.md", "# Claude only\n");
    expect((await runInternalCommand("propagate", undefined, deps)).ok).toBe(true);
    writeHome(deps, ".dsh/skills/review/SKILL.md", "home skill");
    const homeBefore = readTree(deps.homeDir);
    expect(Object.keys(homeBefore)).toContain(".dsh/AGENTS.md");

    const staged = await stage(deps, { harnesses: {} });
    expect(staged.stopSyncing.map((entry) => entry.path)).toEqual([
      ".dsh/AGENTS.md",
      ".dsh/skills",
    ]);
    const result = await apply(deps);

    expect(result).toEqual({
      path: DECLARATIONS_FILE,
      written: true,
      removed: {
        repoFiles: [".dsh/AGENTS.md", ".dsh/skills/review/SKILL.md"],
        overlays: ["canonical/overlays/dsh.md"],
        manifest: { generated: ["dsh"], overlays: ["dsh"] },
        canonicalVersionChanged: true,
      },
    });
    expect(readFileSync(declarationsPath(deps), "utf8")).toBe(
      '{\n  "version": 1,\n  "harnesses": {}\n}\n',
    );
    // The mirrored files and the overlay are gone from the clone, and only they.
    expect(existsSync(join(deps.configDir, ".dsh"))).toBe(false);
    expect(
      existsSync(join(deps.configDir, "canonical", "overlays", "dsh.md")),
    ).toBe(false);
    expect(
      readFileSync(join(deps.configDir, ".claude", "CLAUDE.md"), "utf8"),
    ).toBe("not a dsh file");
    // The manifest is what a repo that never declared the harness records,
    // except that the generated files were made from the earlier version.
    const neverDeclared = makeDeps();
    writeClone(neverDeclared, "canonical/core.md", "# Shared\n");
    writeClone(neverDeclared, "canonical/overlays/claude.md", "# Claude only\n");
    await runInternalCommand("propagate", undefined, neverDeclared);
    const manifest = readManifest(deps);
    const reference = readManifest(neverDeclared);
    expect(manifest.canonical).toEqual(reference.canonical);
    expect(Object.keys(manifest.generated)).toEqual(
      Object.keys(reference.generated),
    );
    expect(manifest.generated.claude?.canonicalVersion).not.toBe(
      manifest.canonical.version,
    );
    // Not one file of the home directory changed.
    expect(readTree(deps.homeDir)).toEqual(homeBefore);
  });

  it("deletes only the repo copies of a path that leaves a harness which keeps others", async () => {
    const deps = makeDeps();
    writeDeclarations(deps, DSH_FILE_TEXT);
    writeClone(deps, ".dsh/AGENTS.md", "repo copy");
    writeClone(deps, ".dsh/skills/review/SKILL.md", "review skill");
    writeClone(deps, "canonical/core.md", "# Shared\n");
    writeClone(deps, "canonical/overlays/dsh.md", "# DSH only\n");
    await runInternalCommand("propagate", undefined, deps);
    writeHome(deps, ".dsh/skills/review/SKILL.md", "home skill");
    const homeBefore = readTree(deps.homeDir);
    const manifestBefore = readManifest(deps);

    const staged = await stage(deps, {
      harnesses: { dsh: { name: DSH.name, instructionsFile: DSH.instructionsFile } },
    });
    const result = await apply(deps);

    expect(staged.stopSyncing).toEqual([
      { harness: "dsh", field: "syncPaths", path: ".dsh/skills" },
    ]);
    expect(staged.removal).toMatchObject({
      harnesses: [],
      repoFiles: [".dsh/skills/review/SKILL.md"],
      overlays: [],
      manifest: { generated: [], overlays: [] },
      canonicalVersionChanges: false,
    });
    expect(result.removed?.repoFiles).toEqual([".dsh/skills/review/SKILL.md"]);
    expect(existsSync(join(deps.configDir, ".dsh", "skills"))).toBe(false);
    expect(
      readFileSync(join(deps.configDir, ".dsh", "AGENTS.md"), "utf8"),
    ).toBe("repo copy");
    expect(
      readFileSync(
        join(deps.configDir, "canonical", "overlays", "dsh.md"),
        "utf8",
      ),
    ).toBe("# DSH only\n");
    expect(readManifest(deps)).toEqual(manifestBefore);
    expect(readTree(deps.homeDir)).toEqual(homeBefore);
  });

  it("keeps the repo copies a remaining declaration covers when a declared directory is narrowed", async () => {
    const deps = makeDeps();
    writeDeclarations(deps, DSH_FILE_TEXT);
    writeClone(deps, ".dsh/skills/review/SKILL.md", "review skill");
    writeClone(deps, ".dsh/skills/notes.txt", "notes");

    const staged = await stage(deps, {
      harnesses: { dsh: { ...DSH, syncPaths: [".dsh/skills/review"] } },
    });
    await apply(deps);

    expect(staged.stopSyncing.map((entry) => entry.path)).toEqual([".dsh/skills"]);
    expect(staged.startSyncing.map((entry) => entry.path)).toEqual([
      ".dsh/skills/review",
    ]);
    expect(staged.removal?.repoFiles).toEqual([".dsh/skills/notes.txt"]);
    expect(existsSync(join(deps.configDir, ".dsh", "skills", "notes.txt"))).toBe(
      false,
    );
    expect(
      readFileSync(
        join(deps.configDir, ".dsh", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("review skill");
  });

  it("takes a path that moves to another harness or field for one that keeps syncing", async () => {
    const deps = makeDeps();
    writeDeclarations(deps, DSH_FILE_TEXT);
    writeClone(deps, ".dsh/AGENTS.md", "repo copy");
    writeClone(deps, ".dsh/skills/review/SKILL.md", "review skill");

    // The skills go to another harness, and the instructions file becomes a
    // path that only transports.
    const staged = await stage(deps, {
      harnesses: {
        dsh: { name: DSH.name, syncPaths: [".dsh/AGENTS.md"] },
        zed: { syncPaths: [".DSH/skills"] },
      },
    });
    const result = await apply(deps);

    expect(staged.startSyncing).toEqual([]);
    expect(staged.stopSyncing).toEqual([]);
    expect(staged.removal).toBeUndefined();
    expect(result).toEqual({ path: DECLARATIONS_FILE, written: true });
    expect(
      readFileSync(join(deps.configDir, ".dsh", "AGENTS.md"), "utf8"),
    ).toBe("repo copy");
    expect(
      existsSync(join(deps.configDir, ".dsh", "skills", "review", "SKILL.md")),
    ).toBe(true);
  });

  it("makes no cleanup when the file it replaces is invalid", async () => {
    const deps = makeDeps();
    writeDeclarations(deps, '{ "version": 1, "harnesses": { "dsh": {} } }');
    writeClone(deps, ".dsh/AGENTS.md", "repo copy");

    const staged = await stage(deps, { harnesses: {} });
    const result = await apply(deps);

    expect(staged.currentProblems).not.toEqual([]);
    expect(staged.removal).toBeUndefined();
    expect(result).toEqual({ path: DECLARATIONS_FILE, written: true });
    expect(
      readFileSync(join(deps.configDir, ".dsh", "AGENTS.md"), "utf8"),
    ).toBe("repo copy");
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
