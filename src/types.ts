import type { ValidationOptions } from "./validation.js";

export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "untracked";
};

export type ValidationResult = {
  command: string;
  status: "passed" | "failed" | "timed_out" | "rejected";
  output: string;
  exitCode?: number | null;
  truncated?: boolean;
  /** Diagnostic from the tool itself (timeout, start failure). Kept apart from capped command output. */
  message?: string;
  durationMs?: number;
};

export type ReviewRequest = {
  repositoryPath: string;
  baseRef?: string;
  validationCommands?: string[];
  format?: "markdown" | "json";
  /** Limits and allowlist applied to validation commands. Set by the interface adapter. */
  validationOptions?: ValidationOptions;
};