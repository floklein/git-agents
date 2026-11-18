import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import {
  computeCanonicalVersion,
  hashContent,
  propagateCanonical,
} from "../src/canonical/canonical";
import {
  driftStateOf,
  gatherDrift,
  parseGeneratedFile,
} from "../src/canonical/gather";
import { runApply, runStage, STAGE_FILE } from "../src/canonical/stage";
import {
  runInternalCommand,
  type InternalDeps,
  type StatusReport,
} from "../src/internal/commands";
import { InternalCommandError } from "../src/internal/errors";
import { BUILT_IN_HARNESSES } from "../src/utils/harnessSet";
import { readSyncManifest } from "../src/utils/manifest";

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

function makeDirs() {
  return {
    configDir: makeTmpDir("ga-custom-config"),
    homeDir: makeTmpDir("ga-custom-home"),
  };
}

function seedCanonical(
  configDir: string,
  core: string,
  overlays: Record<string, string> = {},
): void {
  const overlaysDir = join(configDir, "canonical", "overlays");
  mkdirSync(overlaysDir, { recursive: true });
  writeFileSync(join(configDir, "canonical", "core.md"), core, "utf8");
  for (const [id, content] of Object.entries(overlays)) {
    writeFileSync(join(overlaysDir, `${id}.md`), content, "utf8");
  }
}

function declare(configDir: string, harnesses: Record<string, unknown>): void {
  writeFileSync(
    join(configDir, ".git-agents-harnesses.json"),
    JSON.stringify({ version: 1, harnesses }),
    "utf8",
  );
}

function writeHome(homeDir: string, syncPath: string, content: string): string {
  const path = join(homeDir, ...syncPath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function readHome(homeDir: string, syncPath: string): string {
  return readFileSync(join(homeDir, ...syncPath.split("/")), "utf8");
}

afterEach(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// Captured from the code as it stood before custom harnesses reached
// convergence: a repo that declares nothing must keep producing exactly this.
const BASELINE_VERSION = "5be3f16df690";
const BASELINE_MANIFEST =
  '{\n  "version": 1,\n  "paths": [],\n  "canonical": {\n    "version": "5be3f16df690",\n' +
  '    "core": "78b2119065eebb2a0306bce4244e4990707e525589f7a3337bd19555fc350944",\n' +
  '    "overlays": {\n' +
  '      "claude": "991e219dd5712e1e804f6ddfdf63b3b83e7f492ffee8cf2e4afddf127a460ec3",\n' +
  '      "gemini": "901b5b41e09d543d9a86b5363c90d552fb2422c869fdcd84f5d6e6270b3b1cf9",\n' +
  '      "cursor": "bfe8adf2889ca48710dc06e377734759f0a1d252fd1b2448c3f7b173edcaf345"\n' +
  "    }\n  },\n" +
  '  "generated": {\n' +
  '    "claude": {\n      "path": ".claude/CLAUDE.md",\n' +
  '      "hash": "90885688b287c66ba228a908bd53f24931749062b440fa886fac5b987fd0bbff",\n' +
  '      "canonicalVersion": "5be3f16df690"\n    },\n' +
  '    "codex": {\n      "path": ".codex/AGENTS.md",\n' +
  '      "hash": "92d9264614f1c6d6aff4a58a9af171365b39007195f2178a1fd3cc0b21c21f8a",\n' +
  '      "canonicalVersion": "5be3f16df690"\n    },\n' +
  '    "gemini": {\n      "path": ".gemini/GEMINI.md",\n' +
  '      "hash": "7e29bded35576f0d2de85c001c37da3376164a12814268351f7cb7f9f5a28a75",\n' +
  '      "canonicalVersion": "5be3f16df690"\n    },\n' +
  '    "opencode": {\n      "path": ".config/opencode/AGENTS.md",\n' +
  '      "hash": "92d9264614f1c6d6aff4a58a9af171365b39007195f2178a1fd3cc0b21c21f8a",\n' +
  '      "canonicalVersion": "5be3f16df690"\n    }\n  }\n}\n';
const BASELINE_OVERLAYS = {
  claude: "# Claude only\n",
  cursor: "# Cursor only\n",
  gemini: "# Gemini only\n",
};

describe("with no custom harness", () => {
  it.each([
    ["no declarations file", null],
    ["an empty harnesses object", {}],
  ])("%s: version, manifest and generated files are unchanged", (_, declared) => {
    const { configDir, homeDir } = makeDirs();
    seedCanonical(configDir, "# Shared\n", BASELINE_OVERLAYS);
    if (declared !== null) declare(configDir, declared);

    const result = propagateCanonical(configDir, homeDir);

    expect(result.canonicalVersion).toBe(BASELINE_VERSION);
    expect(
      readFileSync(join(configDir, ".git-agents-sync.json"), "utf8"),
    ).toBe(BASELINE_MANIFEST);
    expect(readHome(homeDir, ".claude/CLAUDE.md")).toBe(
      "<!-- ga:begin core v=5be3f16df690 -->\n# Shared\n<!-- ga:end core -->\n" +
        "<!-- ga:begin overlay harness=claude v=5be3f16df690 -->\n# Claude only\n<!-- ga:end overlay -->\n",
    );
    expect(readHome(homeDir, ".codex/AGENTS.md")).toBe(
      "<!-- ga:begin core v=5be3f16df690 -->\n# Shared\n<!-- ga:end core -->\n",
    );
    expect(result.targets.map((target) => target.harness)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
    ]);
  });
});

describe("propagate with custom harnesses", () => {
  it("generates a custom instructions file and records it under the custom id", () => {
    const { configDir, homeDir } = makeDirs();
    declare(configDir, {
      dsh: { instructionsFile: ".dsh/AGENTS.md", syncPaths: [".dsh/skills"] },
      zed: { syncPaths: [".zed/prompts"] },
    });
    seedCanonical(configDir, "# Shared\n", { dsh: "# DSH only\n" });

    const result = propagateCanonical(configDir, homeDir);

    const version = result.canonicalVersion;
    const generated =
      `<!-- ga:begin core v=${version} -->\n# Shared\n<!-- ga:end core -->\n` +
      `<!-- ga:begin overlay harness=dsh v=${version} -->\n# DSH only\n<!-- ga:end overlay -->\n`;
    expect(readHome(homeDir, ".dsh/AGENTS.md")).toBe(generated);
    expect(readHome(homeDir, ".codex/AGENTS.md")).not.toContain("ga:begin overlay");
    expect(result.targets.map((target) => target.harness)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "dsh",
    ]);
    expect(result.targets[4]).toEqual({
      harness: "dsh",
      syncPath: ".dsh/AGENTS.md",
      path: join(homeDir, ".dsh", "AGENTS.md"),
      changed: true,
    });

    const manifest = readSyncManifest(configDir)!;
    expect(manifest.canonical!.overlays).toEqual({
      dsh: hashContent("# DSH only\n"),
    });
    expect(manifest.generated!.dsh).toEqual({
      path: ".dsh/AGENTS.md",
      hash: hashContent(generated),
      canonicalVersion: version,
    });
    expect(Object.keys(manifest.generated!)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "dsh",
    ]);
    expect(manifest.generated).not.toHaveProperty("zed");
  });

  it("hashes custom overlays after the built-ins, sorted by id", () => {
    const { configDir, homeDir } = makeDirs();
    declare(configDir, {
      zed: { instructionsFile: ".zed/RULES.md" },
      "a-1": { instructionsFile: ".a1/AGENTS.md" },
    });
    seedCanonical(configDir, "# Shared\n", {
      ...BASELINE_OVERLAYS,
      zed: "# Zed only\n",
      "a-1": "# A1 only\n",
    });

    const result = propagateCanonical(configDir, homeDir);

    // The version is a function of the content alone: the order the overlays
    // are handed over in does not matter.
    expect(result.canonicalVersion).toBe(
      computeCanonicalVersion("# Shared\n", {
        zed: "# Zed only\n",
        ...BASELINE_OVERLAYS,
        "a-1": "# A1 only\n",
      }),
    );
    expect(result.canonicalVersion).not.toBe(BASELINE_VERSION);
    expect(Object.keys(readSyncManifest(configDir)!.canonical!.overlays)).toEqual([
      "claude",
      "gemini",
      "cursor",
      "a-1",
      "zed",
    ]);
  });
});

describe("gather with custom harnesses", () => {
  it("reports a custom file without markers as unattributed content", () => {
    const { configDir, homeDir } = makeDirs();
    declare(configDir, { dsh: { instructionsFile: ".dsh/AGENTS.md" } });
    seedCanonical(configDir, "# Shared\n");
    propagateCanonical(configDir, homeDir, BUILT_IN_HARNESSES);
    const path = writeHome(homeDir, ".dsh/AGENTS.md", "# my dsh rules\n");

    const result = gatherDrift(configDir, homeDir);

    expect(result.files.map((file) => file.harness)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "dsh",
    ]);
    const dsh = result.files[4]!;
    expect(dsh).toEqual({
      harness: "dsh",
      syncPath: ".dsh/AGENTS.md",
      path,
      present: true,
      markers: "absent",
      generatedFromVersion: null,
      regions: [{ attribution: "unattributed", content: "# my dsh rules\n" }],
    });
    expect(driftStateOf(dsh)).toBe("unattributed");
    expect(result.inputs.fileHashes.dsh).toBe(hashContent("# my dsh rules\n"));
    expect(driftStateOf(result.files[0]!)).toBe("none");
  });

  it("reports a declared file that does not exist yet as missing", () => {
    const { configDir, homeDir } = makeDirs();
    declare(configDir, { dsh: { instructionsFile: ".dsh/AGENTS.md" } });

    const result = gatherDrift(configDir, homeDir);

    const dsh = result.files.find((file) => file.harness === "dsh")!;
    expect(dsh.present).toBe(false);
    expect(driftStateOf(dsh)).toBe("missing");
    expect(result.inputs.fileHashes).toHaveProperty("dsh", null);
  });

  it("attributes edits inside a custom file's core and overlay blocks", () => {
    const { configDir, homeDir } = makeDirs();
    declare(configDir, { dsh: { instructionsFile: ".dsh/AGENTS.md" } });
    seedCanonical(configDir, "# Shared\n", { dsh: "# DSH only\n" });
    const { canonicalVersion: version } = propagateCanonical(configDir, homeDir);

    const clean = gatherDrift(configDir, homeDir);
    expect(clean.overlays).toEqual({ dsh: "# DSH only\n" });
    expect(clean.files.map(driftStateOf)).toEqual([
      "none",
      "none",
      "none",
      "none",
      "none",
    ]);

    writeHome(
      homeDir,
      ".dsh/AGENTS.md",
      `<!-- ga:begin core v=${version} -->\n# Shared, edited\n<!-- ga:end core -->\n` +
        `<!-- ga:begin overlay harness=dsh v=${version} -->\n# DSH only, edited\n<!-- ga:end overlay -->\n` +
        "# appended by the harness\n",
    );

    const dsh = gatherDrift(configDir, homeDir).files.find(
      (file) => file.harness === "dsh",
    )!;
    expect(dsh.markers).toBe("parsed");
    expect(dsh.generatedFromVersion).toBe(version);
    expect(dsh.regions).toEqual([
      {
        attribution: "core",
        changed: true,
        content: "# Shared, edited\n",
        canonical: "# Shared\n",
      },
      {
        attribution: "overlay",
        changed: true,
        content: "# DSH only, edited\n",
        canonical: "# DSH only\n",
      },
      { attribution: "unattributed", content: "# appended by the harness\n" },
    ]);
    expect(driftStateOf(dsh)).toBe("unattributed");
  });

  it("treats an overlay block that names another harness as mangled", () => {
    const { configDir, homeDir } = makeDirs();
    declare(configDir, { dsh: { instructionsFile: ".dsh/AGENTS.md" } });
    seedCanonical(configDir, "# Shared\n", { claude: "# Claude only\n" });
    propagateCanonical(configDir, homeDir);
    writeHome(homeDir, ".dsh/AGENTS.md", readHome(homeDir, ".claude/CLAUDE.md"));

    const dsh = gatherDrift(configDir, homeDir).files.find(
      (file) => file.harness === "dsh",
    )!;

    expect(dsh.markers).toBe("mangled");
    expect(dsh.regions).toHaveLength(1);
    expect(dsh.regions[0]!.attribution).toBe("unattributed");
  });

  it("round-trips an id with digits and hyphens through generate and parse", () => {
    const { configDir, homeDir } = makeDirs();
    declare(configDir, { "x-9-harness2": { instructionsFile: ".x9/RULES" } });
    seedCanonical(configDir, "# Shared\n", { "x-9-harness2": "# X9 only\n" });
    const { canonicalVersion: version } = propagateCanonical(configDir, homeDir);

    const written = readHome(homeDir, ".x9/RULES");
    expect(written).toContain(
      `<!-- ga:begin overlay harness=x-9-harness2 v=${version} -->\n`,
    );
    expect(parseGeneratedFile(written)).toEqual({
      core: { version, content: "# Shared\n" },
      overlay: { harness: "x-9-harness2", version, content: "# X9 only\n" },
      outside: "",
      state: "parsed",
    });

    const file = gatherDrift(configDir, homeDir).files.find(
      (entry) => entry.harness === "x-9-harness2",
    )!;
    expect(file.markers).toBe("parsed");
    expect(driftStateOf(file)).toBe("none");
  });
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InternalCommandError);
    return (error as InternalCommandError).code;
  }
  throw new Error("expected the call to throw");
}

describe("stage and apply with custom harnesses", () => {
  it("converges a declared instructions file on the first unify", () => {
    const { configDir, homeDir } = makeDirs();
    declare(configDir, {
      dsh: { name: "DeepSeek Harness", instructionsFile: ".dsh/AGENTS.md" },
    });
    writeHome(homeDir, ".claude/CLAUDE.md", "# my rules\n");
    writeHome(homeDir, ".dsh/AGENTS.md", "# my dsh rules\n");
    const gathered = gatherDrift(configDir, homeDir);

    const staged = runStage(configDir, homeDir, {
      core: "# Unified rules\n",
      overlays: { dsh: "# DSH specifics\n", claude: "# Claude specifics\n" },
      inputs: gathered.inputs,
    });

    const version = staged.canonicalVersion;
    const generated =
      `<!-- ga:begin core v=${version} -->\n# Unified rules\n<!-- ga:end core -->\n` +
      `<!-- ga:begin overlay harness=dsh v=${version} -->\n# DSH specifics\n<!-- ga:end overlay -->\n`;
    expect(staged.files.map((file) => file.path)).toEqual([
      "canonical/core.md",
      "canonical/overlays/claude.md",
      "canonical/overlays/dsh.md",
      ".claude/CLAUDE.md",
      ".codex/AGENTS.md",
      ".gemini/GEMINI.md",
      ".config/opencode/AGENTS.md",
      ".dsh/AGENTS.md",
    ]);
    expect(staged.files[2]).toEqual({
      path: "canonical/overlays/dsh.md",
      changed: true,
      diff:
        "--- a/canonical/overlays/dsh.md\n+++ b/canonical/overlays/dsh.md\n" +
        "@@ -0,0 +1,1 @@\n+# DSH specifics\n",
    });
    expect(staged.files[7]).toEqual({
      path: ".dsh/AGENTS.md",
      changed: true,
      diff:
        "--- a/.dsh/AGENTS.md\n+++ b/.dsh/AGENTS.md\n@@ -1,1 +1,6 @@\n" +
        "-# my dsh rules\n" +
        generated
          .split("\n")
          .slice(0, -1)
          .map((line) => `+${line}\n`)
          .join(""),
    });
    expect(existsSync(join(configDir, "canonical"))).toBe(false);
    expect(readHome(homeDir, ".dsh/AGENTS.md")).toBe("# my dsh rules\n");

    const applied = runApply(configDir, homeDir);

    expect(applied.appliedVersion).toBe(version);
    expect(
      readFileSync(join(configDir, "canonical", "overlays", "dsh.md"), "utf8"),
    ).toBe("# DSH specifics\n");
    expect(readHome(homeDir, ".dsh/AGENTS.md")).toBe(generated);
    const manifest = readSyncManifest(configDir)!;
    expect(manifest.version).toBe(1);
    expect(manifest.canonical!.overlays).toEqual({
      claude: hashContent("# Claude specifics\n"),
      dsh: hashContent("# DSH specifics\n"),
    });
    expect(manifest.generated!.dsh).toEqual({
      path: ".dsh/AGENTS.md",
      hash: hashContent(generated),
      canonicalVersion: version,
    });
    expect(existsSync(join(configDir, STAGE_FILE))).toBe(false);
    expect(gatherDrift(configDir, homeDir).files.map(driftStateOf)).toEqual([
      "none",
      "none",
      "none",
      "none",
      "none",
    ]);
  });

  it("rejects an overlay keyed by an id that is not declared", () => {
    const { configDir, homeDir } = makeDirs();
    declare(configDir, { dsh: { instructionsFile: ".dsh/AGENTS.md" } });
    const gathered = gatherDrift(configDir, homeDir);

    expect(
      codeOf(() =>
        runStage(configDir, homeDir, {
          core: "# Core\n",
          overlays: { zed: "# Zed\n" },
          inputs: gathered.inputs,
        }),
      ),
    ).toBe("invalid-input");
    expect(existsSync(join(configDir, STAGE_FILE))).toBe(false);
  });

  it("keeps the size warnings Codex-only", () => {
    const { configDir, homeDir } = makeDirs();
    declare(configDir, { dsh: { instructionsFile: ".dsh/AGENTS.md" } });
    const gathered = gatherDrift(configDir, homeDir);

    const result = runStage(configDir, homeDir, {
      core: `# Huge\n${"x".repeat(33 * 1024)}\n`,
      overlays: { dsh: "# DSH\n" },
      inputs: gathered.inputs,
    });

    expect(result.warnings).toEqual([
      expect.objectContaining({ harness: "codex", level: "over-cap" }),
    ]);
  });

  it("removes a custom overlay dropped from the proposal", () => {
    const { configDir, homeDir } = makeDirs();
    declare(configDir, { dsh: { instructionsFile: ".dsh/AGENTS.md" } });
    seedCanonical(configDir, "# Core\n", { dsh: "# Old overlay\n" });
    propagateCanonical(configDir, homeDir);
    const gathered = gatherDrift(configDir, homeDir);

    const staged = runStage(configDir, homeDir, {
      core: "# Core\n",
      inputs: gathered.inputs,
    });
    expect(
      staged.files.find((file) => file.path === "canonical/overlays/dsh.md")!
        .changed,
    ).toBe(true);
    runApply(configDir, homeDir);

    expect(existsSync(join(configDir, "canonical", "overlays", "dsh.md"))).toBe(
      false,
    );
    expect(readHome(homeDir, ".dsh/AGENTS.md")).not.toContain("ga:begin overlay");
    expect(readSyncManifest(configDir)!.canonical!.overlays).toEqual({});
  });

  it("refuses to apply an overlay staged for a harness that left the set", () => {
    const { configDir, homeDir } = makeDirs();
    declare(configDir, { dsh: { syncPaths: [".dsh/skills"] } });
    const gathered = gatherDrift(configDir, homeDir);
    runStage(configDir, homeDir, {
      core: "# Core\n",
      overlays: { dsh: "# DSH\n" },
      inputs: gathered.inputs,
    });
    rmSync(join(configDir, ".git-agents-harnesses.json"));

    expect(codeOf(() => runApply(configDir, homeDir))).toBe("stale-inputs");
    expect(existsSync(join(configDir, "canonical"))).toBe(false);
  });
});

function makeDeps(): InternalDeps {
  const { configDir, homeDir } = makeDirs();
  return { homeDir, configDir, configFile: join(configDir, "config.json") };
}

async function statusOf(deps: InternalDeps): Promise<StatusReport> {
  const outcome = await runInternalCommand("status", undefined, deps);
  if (!outcome.ok) throw new Error(outcome.error.message);
  return outcome.result as StatusReport;
}

describe("status with custom harnesses", () => {
  it("reports a custom instructions file as untracked, then current", async () => {
    const deps = makeDeps();
    seedCanonical(deps.configDir, "# Core\n");
    propagateCanonical(deps.configDir, deps.homeDir);
    declare(deps.configDir, {
      dsh: { instructionsFile: ".dsh/AGENTS.md" },
      zed: { syncPaths: [".zed/prompts"] },
    });
    const path = writeHome(deps.homeDir, ".dsh/AGENTS.md", "# my dsh rules\n");

    const before = await statusOf(deps);

    expect(before.generated.map((file) => file.harness)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "dsh",
    ]);
    expect(before.generated[4]).toEqual({
      harness: "dsh",
      syncPath: ".dsh/AGENTS.md",
      path,
      present: true,
      state: "untracked",
    });
    expect(before.generated[0]!.state).toBe("current");
    expect(before.drift.files).toEqual({
      claude: "none",
      codex: "none",
      gemini: "none",
      opencode: "none",
      dsh: "unattributed",
    });

    const gathered = await runInternalCommand("gather", undefined, deps);
    if (!gathered.ok) throw new Error(gathered.error.message);
    const staged = await runInternalCommand(
      "stage",
      {
        core: "# Core\n",
        overlays: { dsh: "# my dsh rules\n" },
        inputs: (gathered.result as { inputs: unknown }).inputs,
      },
      deps,
    );
    expect(staged.ok).toBe(true);
    const applied = await runInternalCommand("apply", undefined, deps);
    expect(applied.ok).toBe(true);

    const after = await statusOf(deps);

    expect(after.generated.map((file) => file.state)).toEqual([
      "current",
      "current",
      "current",
      "current",
      "current",
    ]);
    expect(after.drift.files.dsh).toBe("none");
  });

  it("reports only the built-in generated files while the declarations file is invalid", async () => {
    const deps = makeDeps();
    seedCanonical(deps.configDir, "# Core\n", { dsh: "# DSH\n" });
    declare(deps.configDir, {
      dsh: { instructionsFile: ".dsh/AGENTS.md", color: "blue" },
    });
    writeHome(deps.homeDir, ".dsh/AGENTS.md", "# my dsh rules\n");

    const status = await statusOf(deps);

    expect(status.generated.map((file) => file.harness)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
    ]);
    expect(Object.keys(status.drift.files)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
    ]);
    expect(status.caveats[0]!.code).toBe("invalid-harness-declarations");
  });
});

describe("an invalid declarations file", () => {
  it.each(["gather", "stage", "apply", "propagate"])(
    "makes %s refuse with every problem listed",
    async (command) => {
      const deps = makeDeps();
      seedCanonical(deps.configDir, "# Core\n");
      const gathered = gatherDrift(deps.configDir, deps.homeDir);
      const input = { core: "# Core v2\n", inputs: gathered.inputs };
      runStage(deps.configDir, deps.homeDir, input);
      declare(deps.configDir, {
        dsh: { syncPaths: [".dsh/skills"], color: "blue" },
        keys: { syncPaths: [".ssh/keys"] },
      });

      const outcome = await runInternalCommand(
        command,
        command === "stage" ? input : undefined,
        deps,
      );

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("invalid-harness-declarations");
      expect(outcome.error.message).toContain('harness "dsh": unknown field "color"');
      expect(outcome.error.message).toContain(
        '".ssh/keys" is in the credential location ".ssh"',
      );
      // Nothing was generated and the staged proposal was not applied.
      expect(existsSync(join(deps.homeDir, ".claude"))).toBe(false);
      expect(
        readFileSync(join(deps.configDir, "canonical", "core.md"), "utf8"),
      ).toBe("# Core\n");
      expect(existsSync(join(deps.configDir, ".git-agents-sync.json"))).toBe(false);
    },
  );
});
