import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  propagateCanonical,
  canonicalCorePath,
  canonicalOverlayPath,
} from "../src/canonical/canonical";
import {
  driftStateOf,
  gatherDrift,
  parseGeneratedFile,
} from "../src/canonical/gather";

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
  return { configDir: makeTmpDir("ga-gather-config"), homeDir: makeTmpDir("ga-gather-home") };
}

function seedCanonical(
  configDir: string,
  core: string,
  overlays: Record<string, string> = {},
): void {
  mkdirSync(join(configDir, "canonical", "overlays"), { recursive: true });
  writeFileSync(canonicalCorePath(configDir), core, "utf8");
  for (const [harness, content] of Object.entries(overlays)) {
    writeFileSync(canonicalOverlayPath(configDir, harness as any), content, "utf8");
  }
}

afterEach(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("parseGeneratedFile", () => {
  it("parses a core-only generated file", () => {
    const content =
      "<!-- ga:begin core v=abcdefabcdef -->\n# Core\n<!-- ga:end core -->\n";

    const parsed = parseGeneratedFile(content);

    expect(parsed.state).toBe("parsed");
    expect(parsed.core).toEqual({ version: "abcdefabcdef", content: "# Core\n" });
    expect(parsed.overlay).toBeNull();
    expect(parsed.outside).toBe("");
  });

  it("parses core plus overlay and captures appended content", () => {
    const content =
      "<!-- ga:begin core v=aaaaaaaaaaaa -->\n# Core\n<!-- ga:end core -->\n" +
      "<!-- ga:begin overlay harness=claude v=aaaaaaaaaaaa -->\n# Extra\n<!-- ga:end overlay -->\n" +
      "# memory appended by the harness\n";

    const parsed = parseGeneratedFile(content);

    expect(parsed.state).toBe("parsed");
    expect(parsed.overlay).toEqual({
      harness: "claude",
      version: "aaaaaaaaaaaa",
      content: "# Extra\n",
    });
    expect(parsed.outside).toBe("# memory appended by the harness\n");
  });

  it("reports files without markers as absent", () => {
    const parsed = parseGeneratedFile("# just some instructions\n");

    expect(parsed.state).toBe("absent");
    expect(parsed.outside).toBe("# just some instructions\n");
  });

  it("degrades mangled markers to whole-file unattributed", () => {
    const missingEnd =
      "<!-- ga:begin core v=aaaaaaaaaaaa -->\n# Core, no end marker\n";
    const strayMarker =
      "<!-- ga:begin core v=aaaaaaaaaaaa -->\n# Core\n<!-- ga:end core -->\n<!-- ga:end overlay -->\n";

    expect(parseGeneratedFile(missingEnd).state).toBe("mangled");
    expect(parseGeneratedFile(strayMarker).state).toBe("mangled");
    expect(parseGeneratedFile(missingEnd).outside).toBe(missingEnd);
  });
});

describe("gatherDrift", () => {
  it("first run without canonical reports full files as unattributed", () => {
    const { configDir, homeDir } = makeDirs();
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(join(homeDir, ".claude", "CLAUDE.md"), "# my rules\n", "utf8");

    const result = gatherDrift(configDir, homeDir);

    expect(result.canonicalVersion).toBeNull();
    const claude = result.files.find((f) => f.harness === "claude")!;
    expect(claude.regions).toEqual([
      { attribution: "unattributed", content: "# my rules\n" },
    ]);
    expect(driftStateOf(claude)).toBe("unattributed");
    const codex = result.files.find((f) => f.harness === "codex")!;
    expect(codex.present).toBe(false);
    expect(driftStateOf(codex)).toBe("missing");
  });

  it("reports no drift right after propagation", () => {
    const { configDir, homeDir } = makeDirs();
    seedCanonical(configDir, "# Core\n", { claude: "# Extra\n" });
    propagateCanonical(configDir, homeDir);

    const result = gatherDrift(configDir, homeDir);

    for (const file of result.files) {
      expect(driftStateOf(file)).toBe("none");
      expect(file.markers).toBe("parsed");
      expect(file.generatedFromVersion).toBe(result.canonicalVersion);
    }
  });

  it("attributes edits inside core, inside overlay, and appended text", () => {
    const { configDir, homeDir } = makeDirs();
    seedCanonical(configDir, "# Core\n", { claude: "# Extra\n" });
    propagateCanonical(configDir, homeDir);
    const version = gatherDrift(configDir, homeDir).canonicalVersion!;

    const claudeMd = join(homeDir, ".claude", "CLAUDE.md");
    writeFileSync(
      claudeMd,
      `<!-- ga:begin core v=${version} -->\n# Core edited\n<!-- ga:end core -->\n` +
        `<!-- ga:begin overlay harness=claude v=${version} -->\n# Extra edited\n<!-- ga:end overlay -->\n` +
        "# appended memory\n",
      "utf8",
    );

    const claude = gatherDrift(configDir, homeDir).files.find(
      (f) => f.harness === "claude",
    )!;

    const core = claude.regions.find((r) => r.attribution === "core")!;
    const overlay = claude.regions.find((r) => r.attribution === "overlay")!;
    const outside = claude.regions.find((r) => r.attribution === "unattributed")!;
    expect(core).toMatchObject({ changed: true, content: "# Core edited\n" });
    expect(overlay).toMatchObject({ changed: true, content: "# Extra edited\n" });
    expect(outside).toMatchObject({ content: "# appended memory\n" });
    expect(driftStateOf(claude)).toBe("unattributed");
  });

  it("tolerates CRLF line endings without mangling attribution", () => {
    const { configDir, homeDir } = makeDirs();
    seedCanonical(configDir, "# Core\n");
    propagateCanonical(configDir, homeDir);
    const claudeMd = join(homeDir, ".claude", "CLAUDE.md");
    const crlf = readFileSync(claudeMd, "utf8").replace(/\n/g, "\r\n");
    writeFileSync(claudeMd, crlf, "utf8");

    const claude = gatherDrift(configDir, homeDir).files.find(
      (f) => f.harness === "claude",
    )!;

    expect(claude.markers).toBe("parsed");
    expect(driftStateOf(claude)).toBe("none");
  });

  it("degrades an overlay claiming the wrong harness to unattributed", () => {
    const { configDir, homeDir } = makeDirs();
    seedCanonical(configDir, "# Core\n", { claude: "# Extra\n" });
    propagateCanonical(configDir, homeDir);
    const version = gatherDrift(configDir, homeDir).canonicalVersion!;
    const claudeMd = join(homeDir, ".claude", "CLAUDE.md");
    writeFileSync(
      claudeMd,
      `<!-- ga:begin core v=${version} -->\n# Core\n<!-- ga:end core -->\n` +
        `<!-- ga:begin overlay harness=codex v=${version} -->\n# Wrong\n<!-- ga:end overlay -->\n`,
      "utf8",
    );

    const claude = gatherDrift(configDir, homeDir).files.find(
      (f) => f.harness === "claude",
    )!;

    expect(claude.markers).toBe("mangled");
    expect(driftStateOf(claude)).toBe("unattributed");
  });

  it("re-running gather with unchanged inputs yields identical output", () => {
    const { configDir, homeDir } = makeDirs();
    seedCanonical(configDir, "# Core\n");
    propagateCanonical(configDir, homeDir);

    const first = gatherDrift(configDir, homeDir);
    const second = gatherDrift(configDir, homeDir);

    expect(second).toEqual(first);
  });

  it("records input hashes for every target", () => {
    const { configDir, homeDir } = makeDirs();
    seedCanonical(configDir, "# Core\n");
    propagateCanonical(configDir, homeDir);

    const result = gatherDrift(configDir, homeDir);

    expect(Object.keys(result.inputs.fileHashes).sort()).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
    ]);
    for (const hash of Object.values(result.inputs.fileHashes)) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
