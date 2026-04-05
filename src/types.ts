import { z } from "zod";

export type ShellResult = { ok: boolean; output?: string; error?: string };

export const ConfigSchema = z.object({
  remote: z.enum(["gh", "git"]),
  repoUrl: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export type RemoteType = Config["remote"];

export type AgentEntry = { name: string; fileCount: number; contentHash: string };

export type AgentsDiff = {
  added: AgentEntry[];
  removed: AgentEntry[];
  modified: AgentEntry[];
  unchanged: AgentEntry[];
};

export type Screen =
  | { id: "setup"; existingConfig?: Config }
  | { id: "main" }
  | { id: "sync"; mode: "pull" | "push" };
