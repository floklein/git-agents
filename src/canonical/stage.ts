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
import { InternalCommandError } from "../internal/errors";
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

const CODEX_CAP_BYTES = 32 * 1024;
const CODEX_NEAR_CAP_BYTES = 28 * 1024;

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

type StageFileContent = {
  version: 1;
  proposal: { core: string; overlays: Record<string, string> };
  proposalVersion: string;
  inputs: z.infer<typeof InputsSchema>;
};

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
  if (!parsed.success) {
    throw new InternalCommandError(
      "invalid-input",
      `stage input does not match the expected shape: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
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
    const before = currentFile?.present
      ? readFileSync(currentFile.path, "utf8")
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
    alsoUpdates: [".git-agents-sync.json"],
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

  let staged: StageFileContent;
  try {
    staged = JSON.parse(readFileSync(stagePath, "utf8")) as StageFileContent;
  } catch {
    throw new InternalCommandError(
      "invalid-stage",
      `${STAGE_FILE} is not valid JSON. Re-run stage.`,
    );
  }
  if (staged?.version !== 1 || typeof staged.proposal?.core !== "string") {
    throw new InternalCommandError(
      "invalid-stage",
      `${STAGE_FILE} has an unsupported format. Re-run stage.`,
    );
  }

  const current = gatherDrift(configDir, homeDir);
  assertInputsFresh(staged.inputs, current.inputs);

  mkdirSync(join(configDir, CANONICAL_DIR, "overlays"), { recursive: true });
  writeFileSync(canonicalCorePath(configDir), staged.proposal.core, "utf8");
  for (const harness of CANONICAL_HARNESSES) {
    const overlayPath = canonicalOverlayPath(configDir, harness);
    const overlay = staged.proposal.overlays[harness];
    if (overlay !== undefined && overlay.trim() !== "") {
      writeFileSync(overlayPath, overlay, "utf8");
    } else if (existsSync(overlayPath)) {
      rmSync(overlayPath);
    }
  }

  const result = propagateCanonical(configDir, homeDir);
  rmSync(stagePath, { force: true });

  return { ...result, appliedVersion: result.canonicalVersion };
}
