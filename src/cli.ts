#!/usr/bin/env node
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runReview } from "./core.js";
import { BASE_REF_RULES, isSafeBaseRef } from "./git.js";
import { MAX_COMMANDS } from "./validation.js";

export const DEFAULT_OUTPUT = "review-report.md";

export const USAGE = `Usage: inspector review --repo <path> [options]

Options:
  --repo <path>         Repository to inspect (required). Spaces in the path are fine.
  --base-ref <ref>      Branch, tag or commit to compare against.
                        Default: the repository's default branch (origin/HEAD, main, master, ...).
  --validate <command>  Command to run and include in the report. Repeatable (max ${MAX_COMMANDS}).
                        Runs without a shell, with a timeout and a cleaned environment.
  --format markdown     Report format. Only "markdown" is supported.
  --output <file>       Where to write the report (default: ${DEFAULT_OUTPUT}).
                        Use "-" to print the report to standard output instead.
  -h, --help            Show this help.

Exit codes:
  0  report produced and every validation command passed
  1  report produced, but at least one validation command did not pass
  2  wrong usage (bad or missing option)
  3  the repository could not be inspected, or the report could not be written`;

export type CliArgs = {
  repositoryPath: string;
  baseRef?: string;
  validations: string[];
  format: "markdown";
  output: string;
};

export type ParseResult =
  | { kind: "run"; args: CliArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

const VALUE_FLAGS = ["--repo", "--base-ref", "--validate", "--format", "--output"];

const isHelp = (token: string | undefined) => token === "-h" || token === "--help";

/**
 * Help is only requested by a token in an option position, never by a token that is being
 * consumed as another option's value: `--validate -h` runs the command "-h".
 */
function wantsHelp(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    if (isHelp(args[index])) return true;
    if (VALUE_FLAGS.includes(args[index])) {
      const next = args[index + 1];
      if (next === "--help") return true; // a value can never start with "--", so this is a help request
      if (next !== undefined && !next.startsWith("--")) index++; // "-h" here is the option's value
    }
  }
  return false;
}

/** Make text safe for a terminal and keep it to one line: control characters become visible escapes. */
export function printable(text: string, maxLength = 500): string {
  const escaped = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => {
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "\t") return "\\t";
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
  return escaped.length > maxLength ? `${escaped.slice(0, maxLength)}...` : escaped;
}

/** Pure and strict: unknown options, missing values and bad values are errors, never silently ignored. */
export function parseArgs(argv: string[]): ParseResult {
  const fail = (message: string): ParseResult => ({ kind: "error", message });
  if (wantsHelp(argv)) return { kind: "help" };

  const [command, ...rest] = argv;
  if (command === undefined) return fail("Missing command. Use: inspector review --repo <path>");
  if (command !== "review") return fail(`Unknown command ${JSON.stringify(command)}. The only command is "review".`);

  const single = new Map<string, string>();
  const validations: string[] = [];

  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (!token.startsWith("--")) return fail(`Unexpected argument ${JSON.stringify(token)}.`);

    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    if (!VALUE_FLAGS.includes(name)) return fail(`Unknown option ${JSON.stringify(name)}.`);

    let value: string | undefined;
    if (equals !== -1) {
      value = token.slice(equals + 1);
    } else {
      value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) return fail(`${name} needs a value.`);
      index++;
    }
    if (value.trim() === "") return fail(`${name} must not be empty.`);

    if (name === "--validate") {
      validations.push(value);
    } else {
      if (single.has(name)) return fail(`${name} was given more than once.`);
      single.set(name, value);
    }
  }

  const repositoryPath = single.get("--repo");
  if (repositoryPath === undefined) return fail("--repo is required.");

  const format = single.get("--format") ?? "markdown";
  if (format === "json") return fail('--format json is not supported yet; only "markdown" is available.');
  if (format !== "markdown") return fail(`--format must be "markdown" (got ${JSON.stringify(format)}).`);

  const baseRef = single.get("--base-ref");
  if (baseRef !== undefined && !isSafeBaseRef(baseRef)) {
    return fail(`Invalid --base-ref ${JSON.stringify(baseRef.slice(0, 50))}: ${BASE_REF_RULES}`);
  }

  if (validations.length > MAX_COMMANDS) {
    return fail(`Too many --validate commands (${validations.length}; max ${MAX_COMMANDS}).`);
  }

  return {
    kind: "run",
    args: { repositoryPath, baseRef, validations, format: "markdown", output: single.get("--output") ?? DEFAULT_OUTPUT },
  };
}

export type CliIo = { stdout: (text: string) => void; stderr: (text: string) => void };

const processIo: CliIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

/** Runs the CLI and returns its exit code. Never throws, never prints a stack trace. */
export async function runCli(argv: string[], io: CliIo = processIo): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === "help") {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (parsed.kind === "error") {
    io.stderr(`Error: ${printable(parsed.message)}\n\nRun "inspector --help" for usage.\n`);
    return 2;
  }

  const { args } = parsed;
  try {
    const { report, validations } = await runReview({
      repositoryPath: args.repositoryPath,
      baseRef: args.baseRef,
      validationCommands: args.validations,
      format: args.format,
    });

    if (args.output === "-") {
      io.stdout(`${report}\n`);
    } else {
      writeFileSync(args.output, report, "utf8");
      io.stdout(`Review report written to ${printable(args.output)}\n`);
    }

    const notPassed = validations.filter((result) => result.status !== "passed").length;
    if (notPassed > 0) {
      io.stderr(`${notPassed} of ${validations.length} validation command(s) did not pass; see the report.\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    io.stderr(`Error: ${printable(error instanceof Error ? error.message : String(error))}\n`);
    if (process.env.INSPECTOR_DEBUG === "1" && error instanceof Error && error.stack) io.stderr(`${error.stack}\n`);
    return 3;
  }
}

// Only start when run as a program (also through the npm "bin" symlink), not when imported by tests.
function isMain(): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}