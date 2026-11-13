import type { ValidationOptions } from "./validation.js";

export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  /** Previous path, only for renamed files. */
  oldPath?: string;
};

/** What the changes were compared against. */
export type BaseInfo = {
  /** The ref as given or auto-detected, e.g. "origin/main". */
  label: string;
  /** Full commit hash the label resolved to. */
  sha: string;
  /** True when the caller did not pass a base ref and the default branch was detected. */
  detected: boolean;
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