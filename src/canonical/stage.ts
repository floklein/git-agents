import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { unifiedDiff } from "../utils/textdiff";
import { SYNC_MANIFEST_FILE } from "../utils/manifest";
import { InternalCommandError, invalidInputError } from "../internal/errors";
import { CODEX_CAP_BYTES, CODEX_NEAR_CAP_BYTES } from "./limits";
import {
  CANONICAL_DIR,
  CANONICAL_HARNESSES,
  CANONICAL_CORE,
  GENERATED_TARGETS,
  canonicalCorePath,
  canonicalOverlayPath,
  computeCanonicalVersion,
  propagateCanonical,
  readCanonical,
  renderGeneratedFile,
  type CanonicalContent,
  type CanonicalHarness,
  type PropagateResult,
} from "./canonical";
import { gatherDrift, type GatherResult } from "./gather";

export const STAGE_FILE = ".git-agents-stage.json";

const HarnessSchema = z.enum(["claude", "codex", "gemini", "opencode", "cursor"]);

const InputsSchema = z.object({
  canonicalVersion: z.string().nullable(),
  fileHashes: z.record(z.string().nullable()),
});

const StageInputSchema = z.object({
  core: z.string(),
  overlays: z.record(HarnessSchema, z.string()).optional(),
  inputs: InputsSchema,
});

export type StageInput = z.infer<typeof StageInputSchema>;

const StageFileSchema = z.object({
  version: z.literal(1),
  proposal: z.object({
    core: z.string(),
    overlays: z.record(HarnessSchema, z.string()),
  }),
  proposalVersion: z.string(),
  inputs: InputsSchema,
});

type StageFileContent = z.infer<typeof StageFileSchema>;

export type StagedFileDiff = {
  path: string;
  changed: boolean;
  diff: string;
};

export type StageWarning = {
  harness: string;
  bytes: number;
  level: "near-cap" | "over-cap";
};

export type StageResult = {
  canonicalVersion: string;
  files: StagedFileDiff[];
  warnings: StageWarning[];
  alsoUpdates: string[];
};

function assertInputsFresh(
  staged: z.infer<typeof InputsSchema>,
  current: GatherResult["inputs"],
): void {
  const fresh =
    staged.canonicalVersion === current.canonicalVersion &&
    Object.entries(current.fileHashes).every(
      ([harness, hash]) => (staged.fileHashes[harness] ?? null) === hash,
    );
  if (!fresh) {
    throw new InternalCommandError(
      "stale-inputs",
      "Harness files or canonical content changed since they were gathered. Run gather again and re-stage.",
    );
  }
}

function buildProposal(input: StageInput): CanonicalContent {
  const overlays: Partial<Record<CanonicalHarness, string>> = {};
  for (const [harness, content] of Object.entries(input.overlays ?? {})) {
    if (content.trim() !== "") overlays[harness as CanonicalHarness] = content;
  }
  return {
    core: input.core,
    overlays,
    version: computeCanonicalVersion(input.core, overlays),
  };
}

export function runStage(
  configDir: string,
  homeDir: string,
  rawInput: unknown,
): StageResult {
  const parsed = StageInputSchema.safeParse(rawInput);
  if (!parsed.success) throw invalidInputError("stage", parsed.error);
  const input = parsed.data;

  const current = gatherDrift(configDir, homeDir);
  assertInputsFresh(input.inputs, current.inputs);

  const proposal = buildProposal(input);
  const existingCanonical = readCanonical(configDir);

  const files: StagedFileDiff[] = [];
  const corePath = `${CANONICAL_DIR}/${CANONICAL_CORE}`;
  files.push({
    path: corePath,
    changed: (existingCanonical?.core ?? "") !== proposal.core,
    diff: unifiedDiff(existingCanonical?.core ?? "", proposal.core, corePath),
  });
  for (const harness of CANONICAL_HARNESSES) {
    const before = existingCanonical?.overlays[harness] ?? "";
    const after = proposal.overlays[harness] ?? "";
    if (before === "" && after === "") continue;
    const path = `${CANONICAL_DIR}/overlays/${harness}.md`;
    files.push({
      path,
      changed: before !== after,
      diff: unifiedDiff(before, after, path),
    });
  }

  const warnings: StageWarning[] = [];
  for (const target of GENERATED_TARGETS) {
    const rendered = renderGeneratedFile(proposal, target.harness);
    const currentFile = current.files.find((f) => f.harness === target.harness);
    // Normalized like gather, so the gate cannot show drift that the
    // drift summary denies (CRLF conversion is not a content change).
    const before = currentFile?.present
      ? readFileSync(currentFile.path, "utf8").replace(/\r\n/g, "\n")
      : "";
    files.push({
      path: target.syncPath,
      changed: before !== rendered,
      diff: unifiedDiff(before, rendered, target.syncPath),
    });

    if (target.harness === "codex") {
      const bytes = Buffer.byteLength(rendered, "utf8");
      if (bytes >= CODEX_CAP_BYTES) {
        warnings.push({ harness: "codex", bytes, level: "over-cap" });
      } else if (bytes >= CODEX_NEAR_CAP_BYTES) {
        warnings.push({ harness: "codex", bytes, level: "near-cap" });
      }
    }
  }

  const stageFile: StageFileContent = {
    version: 1,
    proposal: {
      core: proposal.core,
      overlays: Object.fromEntries(
        Object.entries(proposal.overlays).filter(
          ([, value]) => value !== undefined,
        ),
      ) as Record<string, string>,
    },
    proposalVersion: proposal.version,
    inputs: input.inputs,
  };
  writeFileSync(
    join(configDir, STAGE_FILE),
    `${JSON.stringify(stageFile, null, 2)}\n`,
    "utf8",
  );

  return {
    canonicalVersion: proposal.version,
    files,
    warnings,
    alsoUpdates: [SYNC_MANIFEST_FILE],
  };
}

export type ApplyResult = PropagateResult & { appliedVersion: string };

export function runApply(configDir: string, homeDir: string): ApplyResult {
  const stagePath = join(configDir, STAGE_FILE);
  if (!existsSync(stagePath)) {
    throw new InternalCommandError(
      "no-stage",
      "Nothing is staged. Run stage with a proposal before apply.",
    );
  }

  let stagedRaw: unknown;
  try {
    stagedRaw = JSON.parse(readFileSync(stagePath, "utf8"));
  } catch {
    throw new InternalCommandError(
      "invalid-stage",
      `${STAGE_FILE} is not valid JSON. Re-run stage.`,
    );
  }
  const stagedParse = StageFileSchema.safeParse(stagedRaw);
  if (!stagedParse.success) {
    throw new InternalCommandError(
      "invalid-stage",
      `${STAGE_FILE} has an unsupported format. Re-run stage.`,
    );
  }
  const staged: StageFileContent = stagedParse.data;

  const current = gatherDrift(configDir, homeDir);
  assertInputsFresh(staged.inputs, current.inputs);

  mkdirSync(join(configDir, CANONICAL_DIR, "overlays"), { recursive: true });
  const corePath = canonicalCorePath(configDir);
  const existingCore = existsSync(corePath)
    ? readFileSync(corePath, "utf8")
    : null;
  if (existingCore !== staged.proposal.core) {
    writeFileSync(corePath, staged.proposal.core, "utf8");
  }
  for (const harness of CANONICAL_HARNESSES) {
    const overlayPath = canonicalOverlayPath(configDir, harness);
    const overlay = staged.proposal.overlays[harness];
    if (overlay !== undefined && overlay.trim() !== "") {
      const existingOverlay = existsSync(overlayPath)
        ? readFileSync(overlayPath, "utf8")
        : null;
      if (existingOverlay !== overlay) {
        writeFileSync(overlayPath, overlay, "utf8");
      }
    } else if (existsSync(overlayPath)) {
      rmSync(overlayPath);
    }
  }

  const result = propagateCanonical(configDir, homeDir);
  rmSync(stagePath, { force: true });

  return { ...result, appliedVersion: result.canonicalVersion };
}
