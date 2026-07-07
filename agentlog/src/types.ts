export type AgentProvider = "codex" | "claude";

export interface SessionRecord {
  provider: AgentProvider;
  id: string;
  title: string;
  cwd?: string;
  path: string;
  createdAt?: Date;
  updatedAt?: Date;
  messageCount?: number;
  preview?: string;
}

export interface ScanOptions {
  homeDir: string;
  targetDir: string;
  providers: AgentProvider[];
  limit?: number;
  query?: string;
}
