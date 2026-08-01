import { z } from "zod";

export type VersionCheckResult = {
  skillVersion: string | null;
  cliVersion: string;
  updateAvailable: boolean;
};

const VersionCheckInputSchema = z.object({ skillVersion: z.string() });

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
  cliVersion: string,
  rawInput: unknown,
): VersionCheckResult {
  const parsed = VersionCheckInputSchema.safeParse(rawInput);
  const skillVersion = parsed.success ? parsed.data.skillVersion.trim() : null;
  const skill = skillVersion === null ? null : parseVersion(skillVersion);
  const cli = parseVersion(cliVersion);
  return {
    skillVersion,
    cliVersion,
    updateAvailable: skill !== null && cli !== null && isOlder(skill, cli),
  };
}
