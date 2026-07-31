import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

export const SYNC_MANIFEST_FILE = ".git-agents-sync.json";

export type CanonicalManifest = {
  version: string;
  core: string;
  overlays: Record<string, string>;
};

export type GeneratedManifestEntry = {
  path: string;
  hash: string;
  canonicalVersion: string;
};

export type SyncManifest = {
  version: 1;
  paths: string[];
  canonical?: CanonicalManifest;
  generated?: Record<string, GeneratedManifestEntry>;
};

export type SyncManifestData = {
  paths: Iterable<string>;
  canonical?: CanonicalManifest;
  generated?: Record<string, GeneratedManifestEntry>;
};

function isSafeManifestPath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    !path ||
    path.trim() !== path ||
    path.includes("\\") ||
    isAbsolute(path) ||
    /^[A-Za-z]:\//.test(path)
  ) {
    return false;
  }

  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]+$/.test(value);
}

function parseCanonicalSection(value: unknown): CanonicalManifest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const section = value as Record<string, unknown>;
  if (typeof section.version !== "string" || !isHash(section.core)) {
    return undefined;
  }
  if (typeof section.overlays !== "object" || section.overlays === null) {
    return undefined;
  }
  const overlays: Record<string, string> = {};
  for (const [key, hash] of Object.entries(section.overlays)) {
    if (!isHash(hash)) return undefined;
    overlays[key] = hash;
  }
  return { version: section.version, core: section.core, overlays };
}

function parseGeneratedSection(
  value: unknown,
): Record<string, GeneratedManifestEntry> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const generated: Record<string, GeneratedManifestEntry> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const candidate = entry as Record<string, unknown>;
    if (
      !isSafeManifestPath(candidate.path) ||
      !isHash(candidate.hash) ||
      typeof candidate.canonicalVersion !== "string"
    ) {
      return undefined;
    }
    generated[key] = {
      path: candidate.path,
      hash: candidate.hash,
      canonicalVersion: candidate.canonicalVersion,
    };
  }
  return generated;
}

export function readSyncManifest(configDir: string): SyncManifest | null {
  const manifestPath = join(configDir, SYNC_MANIFEST_FILE);
  let manifestStat;
  try {
    manifestStat = lstatSync(manifestPath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error(`${SYNC_MANIFEST_FILE} must be a regular file`);
  }

  let descriptor: number | undefined;
  let text: string;
  try {
    descriptor = openSync(manifestPath, "r");
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== manifestStat.dev ||
      openedStat.ino !== manifestStat.ino
    ) {
      throw new Error(`${SYNC_MANIFEST_FILE} changed while it was being read`);
    }
    text = readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${SYNC_MANIFEST_FILE} is not valid JSON`);
  }

  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("paths" in value) ||
    !Array.isArray(value.paths) ||
    !value.paths.every(isSafeManifestPath)
  ) {
    throw new Error(`${SYNC_MANIFEST_FILE} has an unsupported format`);
  }

  const record = value as Record<string, unknown>;
  return {
    version: 1,
    paths: [...new Set(value.paths)],
    canonical: parseCanonicalSection(record.canonical),
    generated: parseGeneratedSection(record.generated),
  };
}

export function writeSyncManifest(
  configDir: string,
  data: SyncManifestData,
): void {
  const manifest: SyncManifest = {
    version: 1,
    paths: [...new Set(data.paths)].sort(),
    ...(data.canonical ? { canonical: data.canonical } : {}),
    ...(data.generated ? { generated: data.generated } : {}),
  };
  const manifestPath = join(configDir, SYNC_MANIFEST_FILE);
  try {
    const existing = lstatSync(manifestPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`${SYNC_MANIFEST_FILE} must be a regular file`);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporaryPath = join(
    configDir,
    `.${SYNC_MANIFEST_FILE}.git-agents-${randomUUID()}`,
  );
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    renameSync(temporaryPath, manifestPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
