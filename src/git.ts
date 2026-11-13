import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import type { BaseInfo, ChangedFile } from "./types.js";

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_TIMEOUT_MS = 300_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_BRANCH_CANDIDATES = ["main", "master", "trunk", "develop"];

/**
 * Base refs are limited to simple names (branch, tag, commit) with optional ~N / ^N suffixes.
 * This is the single source of truth: the CLI and the MCP schema both use it.
 */
export const BASE_REF_MAX_LENGTH = 200;
export const BASE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?:[~^]\d*)*$/;
export const BASE_REF_RULES =
  "base ref must be a branch, tag or commit name (optionally with ~N or ^N), " +
  "cannot start with '-', and cannot be a range (a..b).";

export function isSafeBaseRef(ref: unknown): boolean {
  return (
    typeof ref === "string" &&
    ref.length > 0 &&
    ref.length <= BASE_REF_MAX_LENGTH &&
    BASE_REF_PATTERN.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.endsWith("/")
  );
}

/** A problem with the request or repository, worded so a person or an agent can act on it. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/** 30 s by default; operators can set INSPECTOR_GIT_TIMEOUT_MS (1 to 300000) for very large repositories. */
function gitTimeoutMs(): number {
  const value = Number(process.env.INSPECTOR_GIT_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 1 && value <= MAX_GIT_TIMEOUT_MS ? value : DEFAULT_GIT_TIMEOUT_MS;
}

// Git gets a minimal environment: no inherited GIT_DIR / GIT_EXTERNAL_DIFF / credentials,
// no prompts, no index refresh (so inspecting a repository does not write to it).
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
  for (const name of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TMPDIR", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

type GitRun =
  | { ok: true; stdout: string }
  | { ok: false; status: number | null; stderr: string; problem?: "missing-git" | "timeout" | "too-large" };

function runGit(cwd: string, args: string[]): GitRun {
  try {
    const stdout = execFileSync(
      "git",
      // A repository's own .git/config can make Git run commands (core.fsmonitor runs on
      // status, diff and ls-files). Turn that off for every call.
      ["-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        encoding: "utf8",
        env: gitEnv(),
        timeout: gitTimeoutMs(),
        killSignal: "SIGKILL",
        maxBuffer: GIT_MAX_BUFFER,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    return { ok: true, stdout };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
    const stderr = String(e.stderr ?? "");
    if (e.code === "ENOENT") return { ok: false, status: null, stderr, problem: "missing-git" };
    if (e.code === "ETIMEDOUT") return { ok: false, status: null, stderr, problem: "timeout" };
    if (e.code === "ENOBUFS") return { ok: false, status: null, stderr, problem: "too-large" };
    return { ok: false, status: e.status ?? null, stderr };
  }
}

function failure(run: Extract<GitRun, { ok: false }>, action: string): GitError {
  if (run.problem === "missing-git") return new GitError("Git is not installed or is not on PATH.");
  if (run.problem === "timeout") return new GitError(`Git took longer than ${gitTimeoutMs() / 1000} s and was stopped.`);
  if (run.problem === "too-large") return new GitError("Git produced more output than this tool can handle (too many changed files).");
  if (/dubious ownership/i.test(run.stderr)) {
    return new GitError("Git refuses this repository because it is owned by a different user (safe.directory).");
  }
  const lines = run.stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  const line = lines.find((l) => l.startsWith("fatal:") || l.startsWith("error:")) ?? lines[0] ?? "";
  return new GitError(line ? `${action}: ${line.slice(0, 300)}` : `${action}.`);
}

function shallowHint(root: string): string {
  const run = runGit(root, ["rev-parse", "--is-shallow-repository"]);
  return run.ok && run.stdout.trim() === "true"
    ? " This is a shallow clone: fetch more history (for example `git fetch --unshallow`)."
    : "";
}

function resolveCommit(root: string, spec: string): string | null {
  const run = runGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${spec}^{commit}`]);
  return run.ok ? run.stdout.trim() : null;
}

/** origin/HEAD first, then common default branch names (local, then origin). */
function detectDefaultBase(root: string): string {
  const head = runGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok) {
    const name = head.stdout.trim();
    if (isSafeBaseRef(name) && resolveCommit(root, name)) return name;
  }
  for (const name of DEFAULT_BRANCH_CANDIDATES) {
    if (resolveCommit(root, `refs/heads/${name}`)) return name;
    if (resolveCommit(root, `refs/remotes/origin/${name}`)) return `origin/${name}`;
  }
  throw new GitError(
    `Could not determine the default branch (looked for origin/HEAD, ${DEFAULT_BRANCH_CANDIDATES.join(", ")}). ` +
      "Pass a base ref explicitly.",
  );
}

/** Parse `git diff --name-status -z -M` output. */
function parseNameStatus(raw: string): ChangedFile[] {
  const tokens = raw.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const kind = tokens[i++][0];
    if (kind === "R" || kind === "C") {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      if (path === undefined) break;
      files.push(kind === "R" ? { path, oldPath, status: "renamed" } : { path, status: "added" });
    } else {
      const path = tokens[i++];
      if (path === undefined) break;
      files.push({ path, status: kind === "A" ? "added" : kind === "D" ? "deleted" : "modified" });
    }
  }
  return files;
}

export type Inspection = { files: ChangedFile[]; base: BaseInfo; root: string };

/**
 * Everything that differs from the base: committed changes since the common ancestor,
 * plus staged, unstaged and untracked (non-ignored) changes in the working tree.
 * Throws GitError with a short, actionable message.
 */
export function inspectChanges(repositoryPath: string, baseRef?: string): Inspection {
  let isDirectory = false;
  try {
    isDirectory = statSync(repositoryPath).isDirectory();
  } catch {
    /* reported below */
  }
  if (!isDirectory) throw new GitError(`Repository path is not a directory: ${repositoryPath}`);

  if (baseRef !== undefined && !isSafeBaseRef(baseRef)) {
    throw new GitError(`Invalid base ref ${JSON.stringify(String(baseRef).slice(0, 50))}: ${BASE_REF_RULES}`);
  }

  const top = runGit(repositoryPath, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    if (top.problem || /dubious ownership/i.test(top.stderr)) throw failure(top, "Could not inspect repository");
    throw new GitError(`Not a Git working tree: ${repositoryPath}`);
  }
  const root = top.stdout.trim();

  const head = resolveCommit(root, "HEAD");
  if (!head) throw new GitError("The repository has no commits yet, so there is nothing to compare.");

  const detected = baseRef === undefined;
  const label = baseRef ?? detectDefaultBase(root);
  const sha = resolveCommit(root, label);
  if (!sha) {
    throw new GitError(`Base ref ${JSON.stringify(label)} was not found in this repository.${shallowHint(root)}`);
  }

  const mergeBase = runGit(root, ["merge-base", sha, head]);
  if (!mergeBase.ok || !mergeBase.stdout.trim()) {
    throw new GitError(
      `No common ancestor between ${JSON.stringify(label)} and HEAD, so changes cannot be compared.${shallowHint(root)}`,
    );
  }

  // Compare the common ancestor with the WORKING TREE, so uncommitted edits are included.
  const diff = runGit(root, [
    "diff", "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv", mergeBase.stdout.trim(), "--",
  ]);
  if (!diff.ok) throw failure(diff, "Could not list changed files");

  const untracked = runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!untracked.ok) throw failure(untracked, "Could not list untracked files");

  const files: ChangedFile[] = [
    ...parseNameStatus(diff.stdout),
    ...untracked.stdout.split("\0").filter(Boolean).map((path): ChangedFile => ({ path, status: "untracked" })),
  ];
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { files, base: { label, sha, detected }, root };
}

/** Kept for callers that only need the file list. */
export function changedFiles(repositoryPath: string, baseRef?: string): ChangedFile[] {
  return inspectChanges(repositoryPath, baseRef).files;
}