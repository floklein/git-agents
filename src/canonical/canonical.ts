import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUILT_IN_CONVERGENCE } from "../utils/agentDefs";
import { getLocalSyncPath } from "../utils/config";
import { requireHarnessSet, type Harness } from "../utils/harnessSet";
import {
  readSyncManifest,
  writeSyncManifest,
  type CanonicalManifest,
  type GeneratedManifestEntry,
} from "../utils/manifest";

export const CANONICAL_DIR = "canonical";
export const CANONICAL_CORE = "core.md";
export const CANONICAL_OVERLAYS_DIR = "overlays";

/** The overlay id of a built-in harness. */
export type CanonicalHarness =
  (typeof BUILT_IN_CONVERGENCE)[number]["overlayId"];

/** The built-in overlay ids, in canonical order. */
export const CANONICAL_HARNESSES: CanonicalHarness[] = BUILT_IN_CONVERGENCE.map(
  ({ overlayId }) => overlayId,
);

/** A generated file: `harness` is the overlay id, built-in or custom. */
export type GeneratedTarget = {
  harness: string;
  syncPath: string;
};

// The built-in targets alone; `generatedTargets` gives those of a harness set.
// Cursor has no instructions file, so no generated copy.
export const GENERATED_TARGETS: GeneratedTarget[] = BUILT_IN_CONVERGENCE.flatMap(
  (builtIn): GeneratedTarget[] =>
    "instructionsFile" in builtIn
      ? [{ harness: builtIn.overlayId, syncPath: builtIn.instructionsFile }]
      : [],
);

/** Overlay contents keyed by overlay id, built-in or custom. */
export type CanonicalOverlays = Record<string, string | undefined>;

export type CanonicalContent = {
  core: string;
  overlays: CanonicalOverlays;
  version: string;
};

// The one order overlays are hashed, listed and recorded in: the built-ins in
// their fixed order, then every other id sorted. It depends on the ids alone,
// so it is the same on every machine.
function inCanonicalOrder(ids: readonly string[]): string[] {
  const builtIns: readonly string[] = CANONICAL_HARNESSES;
  return [
    ...builtIns.filter((id) => ids.includes(id)),
    ...[...new Set(ids.filter((id) => !builtIns.includes(id)))].sort(),
  ];
}

/** The overlay ids of a harness set, in canonical order. */
export function canonicalOverlayIds(harnesses: readonly Harness[]): string[] {
  return inCanonicalOrder(harnesses.map((harness) => harness.overlayId));
}

/**
 * The files convergence generates for a harness set: one per harness that has
 * an instructions file, in the order of the set.
 */
export function generatedTargets(
  harnesses: readonly Harness[],
): GeneratedTarget[] {
  return harnesses.flatMap((harness) =>
    harness.instructionsFile !== undefined
      ? [{ harness: harness.overlayId, syncPath: harness.instructionsFile }]
      : [],
  );
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function computeCanonicalVersion(
  core: string,
  overlays: CanonicalOverlays,
): string {
  const hash = createHash("sha256");
  hash.update(`core\0${core}\0`, "utf8");
  for (const harness of inCanonicalOrder(Object.keys(overlays))) {
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
  harness: string,
): string {
  return join(configDir, CANONICAL_DIR, CANONICAL_OVERLAYS_DIR, `${harness}.md`);
}

/**
 * The canonical content of a clone, with the overlays of the given harnesses.
 * An overlay file that belongs to no harness of the set is not read.
 */
export function readCanonical(
  configDir: string,
  harnesses: readonly Harness[] = requireHarnessSet(configDir),
): CanonicalContent | null {
  const corePath = canonicalCorePath(configDir);
  if (!existsSync(corePath)) return null;
  const core = readFileSync(corePath, "utf8");

  const overlays: CanonicalOverlays = {};
  for (const harness of canonicalOverlayIds(harnesses)) {
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
  harness: string,
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

/** What the manifest records of a canonical content, for a harness set. */
export function canonicalManifestSection(
  canonical: CanonicalContent,
  harnesses: readonly Harness[],
): CanonicalManifest {
  const overlays: Record<string, string> = {};
  for (const harness of canonicalOverlayIds(harnesses)) {
    const overlay = canonical.overlays[harness];
    if (overlay !== undefined) overlays[harness] = hashContent(overlay);
  }
  return {
    version: canonical.version,
    core: hashContent(canonical.core),
    overlays,
  };
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
  harnesses: readonly Harness[] = requireHarnessSet(configDir),
): PropagateResult {
  const canonical = readCanonical(configDir, harnesses);
  if (!canonical) {
    throw new Error(
      `No canonical content found. Seed ${CANONICAL_DIR}/${CANONICAL_CORE} in the sync repository first.`,
    );
  }

  const manifest = readSyncManifest(configDir);
  const generated: Record<string, GeneratedManifestEntry> = {};
  const targets = generatedTargets(harnesses).map((target): PropagateTargetResult => {
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

  const canonicalSection = canonicalManifestSection(canonical, harnesses);
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
