import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import type { ValidationResult } from "./types.js";

export type ValidationOptions = {
  /** Kill the command after this many milliseconds. */
  timeoutMs?: number;
  /** Keep at most this many bytes of combined stdout+stderr. */
  maxOutputBytes?: number;
  /** If set, only these executables (e.g. "npm") may run. */
  allowedExecutables?: string[];
  /** Extra environment variable names to pass through (default: none). */
  extraEnvNames?: string[];
};

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_COMMANDS = 10;
export const MAX_COMMAND_LENGTH = 500;

// Only these variables reach the child process. API keys, tokens and
// anything else in the parent environment are NOT passed on.
const SAFE_ENV_NAMES = [
  "PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL",
  "TMPDIR", "TEMP", "TMP", "SystemRoot",
];

// Characters that only mean something to a shell. We do not use a shell,
// so instead of silently treating them as plain text we reject them.
const SHELL_OPERATORS = /[;&|<>`$()\n\r\0]/;

/**
 * Split a command string into [executable, ...args] without a shell.
 * Supports simple single/double quotes. Throws on anything unsafe or unclear.
 */
export function parseCommand(command: string): string[] {
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("Command must be a non-empty string.");
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`Command is longer than ${MAX_COMMAND_LENGTH} characters.`);
  }
  // Newlines, carriage returns and NUL are rejected everywhere, even inside quotes.
  // NUL would make spawn throw, and newlines can break the Markdown report.
  if (/[\n\r\0]/.test(command)) {
    throw new Error("Newline, carriage return and NUL characters are not allowed in commands.");
  }

  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
    } else if (/\s/.test(char) && char !== "\n" && char !== "\r") {
      if (hasToken || current) tokens.push(current);
      current = "";
      hasToken = false;
    } else if (SHELL_OPERATORS.test(char)) {
      throw new Error(
        `Shell operator "${char.trim() || "control character"}" is not allowed. Commands run without a shell.`,
      );
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (quote) throw new Error("Unterminated quote in command.");
  if (hasToken || current) tokens.push(current);
  if (tokens.length === 0) throw new Error("Command must be a non-empty string.");
  return tokens;
}

function buildEnv(extraNames: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "true" };
  for (const name of [...SAFE_ENV_NAMES, ...extraNames]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function rejected(command: string, reason: string): ValidationResult {
  return { command, status: "rejected", output: reason, exitCode: null };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_LOOKING = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

function checkOptions(options: ValidationOptions): string | null {
  const positive = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (options.timeoutMs !== undefined && !positive(options.timeoutMs)) {
    return "timeoutMs must be a positive finite number.";
  }
  if (options.maxOutputBytes !== undefined && !positive(options.maxOutputBytes)) {
    return "maxOutputBytes must be a positive finite number.";
  }
  if (
    options.allowedExecutables &&
    !options.allowedExecutables.every((e) => typeof e === "string" && /^[A-Za-z0-9._-]+$/.test(e))
  ) {
    return "allowedExecutables must be plain executable names (no paths or spaces).";
  }
  if (options.extraEnvNames) {
    for (const name of options.extraEnvNames) {
      if (typeof name !== "string" || !ENV_NAME.test(name)) return `Invalid environment variable name: ${String(name)}`;
      if (SECRET_LOOKING.test(name)) return `Environment variable "${name}" looks like a secret and cannot be passed on.`;
    }
  }
  return null;
}

/** Never throws: every outcome is returned as a ValidationResult. */
export function runValidation(
  command: string,
  cwd: string,
  options: ValidationOptions = {},
): Promise<ValidationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const optionError = checkOptions(options);
  if (optionError) return Promise.resolve(rejected(command, `Invalid options: ${optionError}`));

  let argv: string[];
  try {
    argv = parseCommand(command);
  } catch (error) {
    return Promise.resolve(rejected(command, (error as Error).message));
  }
  const [executable, ...args] = argv;
  if (!executable) return Promise.resolve(rejected(command, "Executable name must not be empty."));
  try {
    if (!statSync(cwd).isDirectory()) throw new Error();
  } catch {
    return Promise.resolve(rejected(command, `Working directory is not a directory: ${cwd}`));
  }
  if (options.allowedExecutables && !options.allowedExecutables.includes(executable)) {
    return Promise.resolve(rejected(command, `Executable "${executable}" is not on the allowlist.`));
  }

  return new Promise((resolve) => {
    const started = Date.now();
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    let timer: NodeJS.Timeout | undefined;

    const finish = (status: ValidationResult["status"], exitCode: number | null, message?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8");
      resolve({ command, status, output, exitCode, truncated, message, durationMs: Date.now() - started });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        cwd,
        env: buildEnv(options.extraEnvNames),
        shell: false,
        detached: process.platform !== "win32", // own process group, so we can kill children too
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish("failed", null, `Could not start command: ${(error as Error).message}`);
      return;
    }

    const killTree = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };

    timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const collect = (data: Buffer) => {
      if (bytes >= maxBytes) {
        truncated = true;
        return; // keep draining so the child never blocks, but store nothing more
      }
      const room = maxBytes - bytes;
      if (data.length > room) {
        chunks.push(data.subarray(0, room));
        bytes = maxBytes;
        truncated = true;
      } else {
        chunks.push(data);
        bytes += data.length;
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    child.on("error", (error) => finish("failed", null, `Could not start command: ${error.message}`));
    child.on("close", (code) => {
      if (timedOut) finish("timed_out", code, `Command timed out after ${timeoutMs} ms and was killed.`);
      else finish(code === 0 ? "passed" : "failed", code);
    });
  });
}

export async function runValidations(
  commands: string[],
  cwd: string,
  options: ValidationOptions = {},
): Promise<ValidationResult[]> {
  if (commands.length > MAX_COMMANDS) {
    throw new Error(`Too many validation commands (max ${MAX_COMMANDS}).`);
  }
  if (commands.length > 0) {
    let isDirectory = false;
    try {
      isDirectory = statSync(cwd).isDirectory();
    } catch {
      /* handled below */
    }
    if (!isDirectory) throw new Error(`Repository path is not a directory: ${cwd}`);
  }
  const results: ValidationResult[] = [];
  for (const command of commands) {
    results.push(await runValidation(command, cwd, options));
  }
  return results;
}