import { z } from "zod";
import { AGENT_DEFS } from "../utils/agentDefs";
import {
  runSyncExecute,
  runSyncLoad,
  type FlowDeps,
} from "../utils/flows";
import { InternalCommandError, invalidInputError } from "./errors";
import type { InternalDeps } from "./commands";

export type SyncFlowDeps = Pick<FlowDeps, "gitPull" | "gitAddCommitPush">;

const ExpectedPathSchema = z.object({
  agentId: z.string(),
  path: z.string(),
  status: z.enum(["added", "removed", "modified", "unchanged"]),
  localHash: z.string().nullable(),
  remoteHash: z.string().nullable(),
});

const SyncInputSchema = z
  .object({
    execute: z.boolean().optional(),
    expected: z.array(ExpectedPathSchema).optional(),
  })
  .optional();

export type SyncPathReport = z.infer<typeof ExpectedPathSchema>;

export type SyncAgentReport = {
  agentId: string;
  name: string;
  paths: Omit<SyncPathReport, "agentId">[];
};

export type SyncCommandResult = {
  mode: "pull" | "push";
  executed: boolean;
  agents: SyncAgentReport[];
  message?: string;
};

function flattenReport(agents: SyncAgentReport[]): SyncPathReport[] {
  return agents.flatMap((agent) =>
    agent.paths.map((path) => ({ agentId: agent.agentId, ...path })),
  );
}

function pathKey(entry: SyncPathReport): string {
  return `${entry.agentId}\0${entry.path}`;
}

function assertExpectedMatches(
  expected: SyncPathReport[],
  fresh: SyncPathReport[],
): void {
  const freshByKey = new Map(fresh.map((entry) => [pathKey(entry), entry]));
  const stale =
    expected.length !== fresh.length ||
    expected.some((entry) => {
      const current = freshByKey.get(pathKey(entry));
      return (
        !current ||
        current.status !== entry.status ||
        current.localHash !== entry.localHash ||
        current.remoteHash !== entry.remoteHash
      );
    });
  if (stale) {
    throw new InternalCommandError(
      "stale-inputs",
      "Synced paths changed since they were previewed. Preview again and re-confirm.",
    );
  }
}

export async function runSyncCommand(
  mode: "pull" | "push",
  deps: InternalDeps,
  rawInput: unknown,
  flowDeps: SyncFlowDeps,
): Promise<SyncCommandResult> {
  const parsed = SyncInputSchema.safeParse(rawInput);
  if (!parsed.success) throw invalidInputError(mode, parsed.error);
  const input = parsed.data;

  if (input?.execute && !input.expected) {
    throw new InternalCommandError(
      "invalid-input",
      `${mode} with execute:true requires the previewed rows as "expected"; run a preview first and pass its rows back.`,
    );
  }

  const load = await runSyncLoad(
    mode,
    AGENT_DEFS,
    deps.configDir,
    flowDeps,
    deps.homeDir,
  );
  if (load.type === "error") {
    throw new InternalCommandError("sync-load-failed", load.message);
  }

  const agents = load.agentDiffs.map((entry): SyncAgentReport => ({
    agentId: entry.def.id,
    name: entry.def.name,
    paths: entry.pathDiffs.map((diff) => ({
      path: diff.path,
      status: diff.status,
      localHash: diff.local?.contentHash ?? null,
      remoteHash: diff.remote?.contentHash ?? null,
    })),
  }));

  if (!input?.execute) {
    return { mode, executed: false, agents };
  }

  if (input.expected) {
    assertExpectedMatches(input.expected, flattenReport(agents));
  }

  const execution = await runSyncExecute(
    mode,
    load.agentDiffs,
    deps.configDir,
    flowDeps,
  );
  if (execution.type === "error") {
    throw new InternalCommandError("sync-execute-failed", execution.message);
  }

  return { mode, executed: true, agents, message: execution.message };
}
