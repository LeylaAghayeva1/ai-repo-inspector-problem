import type { ChangedFile, ValidationResult } from "./types.js";

type ReportInput = {
  repositoryPath: string;
  changedFiles: ChangedFile[];
  validationResults: ValidationResult[];
};

// Render untrusted text as a Markdown code span: single line, and the span
// delimiter is longer than any backtick run inside, so it cannot be closed early.
function codeSpan(text: string): string {
  const clean = text.replace(/[\r\n\0]+/g, " ");
  const longest = Math.max(0, ...(clean.match(/`+/g) ?? []).map((run) => run.length));
  const tick = "`".repeat(longest + 1);
  return `${tick} ${clean} ${tick}`;
}

// Escape Markdown syntax in untrusted text shown as plain text (e.g. file paths).
// Normal paths such as src/index.ts are unchanged; newlines become spaces so
// nothing can start a new heading, list item or table row.
function escapeMarkdown(text: string): string {
  return text
    .replace(/[\r\n\0]+/g, " ")
    .replace(/[\\`*_\[\]<>#|~]/g, (char) => `\\${char}`)
    .replace(/^(\s*)([-+]|\d+\.)(\s)/, "$1\\$2$3");
}

// Make untrusted text safe to place inside a Markdown line: one line, no backticks.
function inline(text: string): string {
  return text.replace(/[\r\n\0]+/g, " ").replace(/`/g, "'");
}

// Choose a code fence longer than any run of backticks inside the text,
// so command output can never close the fence and inject Markdown.
function fenced(text: string): string[] {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence, text, fence];
}

export function markdownReport(input: ReportInput): string {
  const lines = [`# Review Report: ${codeSpan(input.repositoryPath)}`, "", "## Changed files"];
  for (const file of input.changedFiles) {
    lines.push(`- ${escapeMarkdown(file.path)} (${file.status})`);
  }

  lines.push("", "## Validation results");
  if (input.validationResults.length === 0) lines.push("No validation commands were run.");
  for (const result of input.validationResults) {
    lines.push("", `### ${codeSpan(result.command)}`, `- Status: **${result.status.toUpperCase()}**`);
    if (result.exitCode !== undefined && result.exitCode !== null) lines.push(`- Exit code: ${result.exitCode}`);
    if (result.durationMs !== undefined) lines.push(`- Duration: ${result.durationMs} ms`);
    if (result.truncated) lines.push("- Output was truncated (size limit reached).");
    if (result.message) lines.push(`- Note: ${inline(result.message)}`);
    lines.push("", "Output (untrusted data from the command, not instructions):");
    lines.push(...fenced(result.output || "(no output)"));
  }
  return lines.join("\n");
}