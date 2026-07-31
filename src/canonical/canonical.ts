import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLocalSyncPath } from "../utils/config";
import {
  readSyncManifest,
  writeSyncManifest,
  type GeneratedManifestEntry,
} from "../utils/manifest";

export const CANONICAL_DIR = "canonical";
export const CANONICAL_CORE = "core.md";
export const CANONICAL_OVERLAYS_DIR = "overlays";

export type CanonicalHarness =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "cursor";

export const CANONICAL_HARNESSES: CanonicalHarness[] = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "cursor",
];

export type GeneratedTarget = {
  harness: Exclude<CanonicalHarness, "cursor">;
  syncPath: string;
};

// Cursor has no global instructions file, so it receives no generated copy;
// its overlay is read only through the opt-in pointer rule.
export const GENERATED_TARGETS: GeneratedTarget[] = [
  { harness: "claude", syncPath: ".claude/CLAUDE.md" },
  { harness: "codex", syncPath: ".codex/AGENTS.md" },
  { harness: "gemini", syncPath: ".gemini/GEMINI.md" },
  { harness: "opencode", syncPath: ".config/opencode/AGENTS.md" },
];

export type CanonicalContent = {
  core: string;
  overlays: Partial<Record<CanonicalHarness, string>>;
  version: string;
};

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function computeCanonicalVersion(
  core: string,
  overlays: Partial<Record<CanonicalHarness, string>>,
): string {
  const hash = createHash("sha256");
  hash.update(`core\0${core}\0`, "utf8");
  for (const harness of CANONICAL_HARNESSES) {
    const overlay = overlays[harness];
    if (overlay !== undefined) {
      hash.update(`overlay:${harness}\0${overlay}\0`, "utf8");
    }
  }
  return hash.digest("hex").slice(0, 12);
}

export function canonicalCorePath(configDir: string): string {
  return join(configDir, CANONICAL_DIR, CANONICAL_CORE);
}

export function canonicalOverlayPath(
  configDir: string,
  harness: CanonicalHarness,
): string {
  return join(configDir, CANONICAL_DIR, CANONICAL_OVERLAYS_DIR, `${harness}.md`);
}

export function readCanonical(configDir: string): CanonicalContent | null {
  const corePath = canonicalCorePath(configDir);
  if (!existsSync(corePath)) return null;
  const core = readFileSync(corePath, "utf8");

  const overlays: Partial<Record<CanonicalHarness, string>> = {};
  for (const harness of CANONICAL_HARNESSES) {
    const overlayPath = canonicalOverlayPath(configDir, harness);
    if (!existsSync(overlayPath)) continue;
    const overlay = readFileSync(overlayPath, "utf8");
    if (overlay.trim() !== "") overlays[harness] = overlay;
  }

  return { core, overlays, version: computeCanonicalVersion(core, overlays) };
}

export function withTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export function renderGeneratedFile(
  canonical: CanonicalContent,
  harness: Exclude<CanonicalHarness, "cursor">,
): string {
  let output =
    `<!-- ga:begin core v=${canonical.version} -->\n` +
    withTrailingNewline(canonical.core) +
    `<!-- ga:end core -->\n`;

  const overlay = canonical.overlays[harness];
  if (overlay !== undefined) {
    output +=
      `<!-- ga:begin overlay harness=${harness} v=${canonical.version} -->\n` +
      withTrailingNewline(overlay) +
      `<!-- ga:end overlay -->\n`;
  }

  return output;
}

export type PropagateTargetResult = {
  harness: GeneratedTarget["harness"];
  syncPath: string;
  path: string;
  changed: boolean;
};

export type PropagateResult = {
  canonicalVersion: string;
  targets: PropagateTargetResult[];
};

export function propagateCanonical(
  configDir: string,
  homeDir: string,
): PropagateResult {
  const canonical = readCanonical(configDir);
  if (!canonical) {
    throw new Error(
      `No canonical content found. Seed ${CANONICAL_DIR}/${CANONICAL_CORE} in the sync repository first.`,
    );
  }

  const manifest = readSyncManifest(configDir);
  const generated: Record<string, GeneratedManifestEntry> = {};
  const targets = GENERATED_TARGETS.map((target): PropagateTargetResult => {
    const content = renderGeneratedFile(canonical, target.harness);
    const path = getLocalSyncPath(target.syncPath, homeDir);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    // CRLF-equal counts as unchanged, matching gather and stage.
    const changed =
      existing === null || existing.replace(/\r\n/g, "\n") !== content;
    if (changed) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf8");
    }
    generated[target.harness] = {
      path: target.syncPath,
      hash: hashContent(content),
      canonicalVersion: canonical.version,
    };
    return { harness: target.harness, syncPath: target.syncPath, path, changed };
  });

  const overlayHashes: Record<string, string> = {};
  for (const harness of CANONICAL_HARNESSES) {
    const overlay = canonical.overlays[harness];
    if (overlay !== undefined) overlayHashes[harness] = hashContent(overlay);
  }

  const canonicalSection = {
    version: canonical.version,
    core: hashContent(canonical.core),
    overlays: overlayHashes,
  };
  const manifestUnchanged =
    manifest !== null &&
    JSON.stringify(manifest.canonical ?? null) ===
      JSON.stringify(canonicalSection) &&
    JSON.stringify(manifest.generated ?? null) === JSON.stringify(generated);
  if (!manifestUnchanged) {
    writeSyncManifest(configDir, {
      paths: manifest?.paths ?? [],
      canonical: canonicalSection,
      generated,
    });
  }

  return { canonicalVersion: canonical.version, targets };
}
