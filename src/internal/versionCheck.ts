import pkg from "../../package.json" with { type: "json" };
import type { InternalDeps } from "./commands";

export type VersionCheckResult = {
  skillVersion: string | null;
  cliVersion: string;
  updateAvailable: boolean;
};

function parseVersion(version: string): number[] | null {
  const trimmed = version.trim();
  if (!/^\d+(\.\d+)*$/.test(trimmed)) return null;
  return trimmed.split(".").map(Number);
}

function isOlder(a: number[], b: number[]): boolean {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

// Never throws and never returns an error envelope: the orchestrating
// agent must have nothing to relay except a genuine offer, so anything
// unparseable simply reads as "no update".
export function runVersionCheck(
  deps: InternalDeps,
  rawInput: unknown,
): VersionCheckResult {
  const cliVersion = deps.cliVersion ?? pkg.version;
  const raw =
    typeof rawInput === "object" && rawInput !== null
      ? (rawInput as Record<string, unknown>).skillVersion
      : undefined;
  const skillVersion = typeof raw === "string" ? raw.trim() : null;
  const skill = skillVersion === null ? null : parseVersion(skillVersion);
  const cli = parseVersion(cliVersion);
  return {
    skillVersion,
    cliVersion,
    updateAvailable: skill !== null && cli !== null && isOlder(skill, cli),
  };
}
