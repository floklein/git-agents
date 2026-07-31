import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  canonicalCorePath,
  canonicalOverlayPath,
  computeCanonicalVersion,
  hashContent,
  propagateCanonical,
  readCanonical,
  renderGeneratedFile,
  GENERATED_TARGETS,
} from "../src/canonical/canonical";
import { readSyncManifest, writeSyncManifest } from "../src/utils/manifest";
import { getLocalSyncPath } from "../src/utils/config";

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

function seedCanonical(
  configDir: string,
  core: string,
  overlays: Record<string, string> = {},
): void {
  mkdirSync(join(configDir, "canonical", "overlays"), { recursive: true });
  writeFileSync(canonicalCorePath(configDir), core, "utf8");
  for (const [harness, content] of Object.entries(overlays)) {
    writeFileSync(
      canonicalOverlayPath(configDir, harness as any),
      content,
      "utf8",
    );
  }
}

afterEach(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("computeCanonicalVersion", () => {
  it("is deterministic and changes with content", () => {
    const a = computeCanonicalVersion("core", { claude: "x" });
    const b = computeCanonicalVersion("core", { claude: "x" });
    const c = computeCanonicalVersion("core", { claude: "y" });
    const d = computeCanonicalVersion("other", { claude: "x" });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("readCanonical", () => {
  it("returns null when no core exists", () => {
    expect(readCanonical(makeTmpDir("ga-canon"))).toBeNull();
  });

  it("reads core and non-empty overlays", () => {
    const configDir = makeTmpDir("ga-canon");
    seedCanonical(configDir, "# Core\n", {
      claude: "# Claude extras\n",
      gemini: "   \n",
    });

    const canonical = readCanonical(configDir)!;

    expect(canonical.core).toBe("# Core\n");
    expect(canonical.overlays.claude).toBe("# Claude extras\n");
    expect(canonical.overlays.gemini).toBeUndefined();
  });
});

describe("renderGeneratedFile", () => {
  it("renders core-only content with exact markers", () => {
    const configDir = makeTmpDir("ga-canon");
    seedCanonical(configDir, "# Core");
    const canonical = readCanonical(configDir)!;

    const rendered = renderGeneratedFile(canonical, "codex");

    expect(rendered).toBe(
      `<!-- ga:begin core v=${canonical.version} -->\n# Core\n<!-- ga:end core -->\n`,
    );
  });

  it("appends the overlay block only for harnesses that have one", () => {
    const configDir = makeTmpDir("ga-canon");
    seedCanonical(configDir, "# Core\n", { claude: "# Extras\n" });
    const canonical = readCanonical(configDir)!;

    const withOverlay = renderGeneratedFile(canonical, "claude");
    const withoutOverlay = renderGeneratedFile(canonical, "codex");

    expect(withOverlay).toBe(
      `<!-- ga:begin core v=${canonical.version} -->\n# Core\n<!-- ga:end core -->\n` +
        `<!-- ga:begin overlay harness=claude v=${canonical.version} -->\n# Extras\n<!-- ga:end overlay -->\n`,
    );
    expect(withoutOverlay).not.toContain("ga:begin overlay");
  });
});

describe("propagateCanonical", () => {
  it("throws a clear error without canonical content", () => {
    const configDir = makeTmpDir("ga-canon");
    const homeDir = makeTmpDir("ga-home");

    expect(() => propagateCanonical(configDir, homeDir)).toThrow(
      /No canonical content/,
    );
  });

  it("writes all four generated files and records the manifest", () => {
    const configDir = makeTmpDir("ga-canon");
    const homeDir = makeTmpDir("ga-home");
    seedCanonical(configDir, "# Shared\n", { claude: "# Claude only\n" });

    const result = propagateCanonical(configDir, homeDir);

    expect(result.targets).toHaveLength(4);
    for (const target of result.targets) {
      expect(target.changed).toBe(true);
      expect(existsSync(target.path)).toBe(true);
      const content = readFileSync(target.path, "utf8");
      expect(content).toContain(`ga:begin core v=${result.canonicalVersion}`);
    }
    expect(
      readFileSync(getLocalSyncPath(".claude/CLAUDE.md", homeDir), "utf8"),
    ).toContain("ga:begin overlay harness=claude");
    expect(
      readFileSync(getLocalSyncPath(".codex/AGENTS.md", homeDir), "utf8"),
    ).not.toContain("ga:begin overlay");

    const manifest = readSyncManifest(configDir)!;
    expect(manifest.canonical!.version).toBe(result.canonicalVersion);
    expect(manifest.canonical!.core).toBe(hashContent("# Shared\n"));
    expect(manifest.canonical!.overlays).toEqual({
      claude: hashContent("# Claude only\n"),
    });
    for (const target of GENERATED_TARGETS) {
      const entry = manifest.generated![target.harness]!;
      expect(entry.path).toBe(target.syncPath);
      expect(entry.canonicalVersion).toBe(result.canonicalVersion);
      const written = readFileSync(
        getLocalSyncPath(target.syncPath, homeDir),
        "utf8",
      );
      expect(entry.hash).toBe(hashContent(written));
    }
  });

  it("is idempotent: a second run writes nothing", () => {
    const configDir = makeTmpDir("ga-canon");
    const homeDir = makeTmpDir("ga-home");
    seedCanonical(configDir, "# Shared\n");

    propagateCanonical(configDir, homeDir);
    const second = propagateCanonical(configDir, homeDir);

    for (const target of second.targets) {
      expect(target.changed).toBe(false);
    }
  });

  it("does not generate anything for Cursor", () => {
    const configDir = makeTmpDir("ga-canon");
    const homeDir = makeTmpDir("ga-home");
    seedCanonical(configDir, "# Shared\n", { cursor: "# Cursor overlay\n" });

    const result = propagateCanonical(configDir, homeDir);

    expect(result.targets.map((t) => t.harness)).not.toContain("cursor");
    expect(existsSync(join(homeDir, ".cursor"))).toBe(false);
  });

  it("preserves existing manifest paths", () => {
    const configDir = makeTmpDir("ga-canon");
    const homeDir = makeTmpDir("ga-home");
    writeSyncManifest(configDir, { paths: [".claude/skills"] });
    seedCanonical(configDir, "# Shared\n");

    propagateCanonical(configDir, homeDir);

    expect(readSyncManifest(configDir)!.paths).toEqual([".claude/skills"]);
  });
});

describe("manifest canonical sections", () => {
  it("round-trips canonical and generated through write and read", () => {
    const configDir = makeTmpDir("ga-manifest");
    writeSyncManifest(configDir, {
      paths: [".claude/CLAUDE.md"],
      canonical: { version: "abc123abc123", core: "aa", overlays: { claude: "bb" } },
      generated: {
        claude: {
          path: ".claude/CLAUDE.md",
          hash: "cc",
          canonicalVersion: "abc123abc123",
        },
      },
    });

    const manifest = readSyncManifest(configDir)!;

    expect(manifest.paths).toEqual([".claude/CLAUDE.md"]);
    expect(manifest.canonical!.version).toBe("abc123abc123");
    expect(manifest.generated!.claude!.hash).toBe("cc");
  });

  it("drops malformed canonical sections instead of failing", () => {
    const configDir = makeTmpDir("ga-manifest");
    writeFileSync(
      join(configDir, ".git-agents-sync.json"),
      JSON.stringify({
        version: 1,
        paths: [],
        canonical: { version: 42 },
        generated: { claude: { path: "../escape", hash: "zz", canonicalVersion: 1 } },
      }),
      "utf8",
    );

    const manifest = readSyncManifest(configDir)!;

    expect(manifest.paths).toEqual([]);
    expect(manifest.canonical).toBeUndefined();
    expect(manifest.generated).toBeUndefined();
  });
});
