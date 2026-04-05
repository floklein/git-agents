export type RemoteType = "gh" | "git";

export type Config = {
  remote: RemoteType;
  repoUrl?: string; // Only for "git" mode
};

export type AgentEntry = { name: string; fileCount: number };

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
