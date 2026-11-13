import { describe, expect, it } from "vitest";
import { markdownReport } from "../src/report.js";

describe("markdownReport", () => {
  it("lists changed files and validation output", () => {
    const report = markdownReport({
      repositoryPath: "/work/sample",
      changedFiles: [{ path: "src/index.ts", status: "modified" }],
      validationResults: [{ command: "npm test", status: "passed", output: "ok" }],
    });

    expect(report).toContain("src/index.ts (modified)");
    expect(report).toContain("npm test");
    expect(report).toContain("ok");
  });
});
describe("markdownReport validation display", () => {
  const base = { repositoryPath: "/work/sample", changedFiles: [] };

  it("shows status, exit code and truncation even when output is empty", () => {
    const report = markdownReport({
      ...base,
      validationResults: [
        { command: "npm test", status: "failed", output: "", exitCode: 1, durationMs: 42, truncated: true },
      ],
    });
    expect(report).toContain("Status: **FAILED**");
    expect(report).toContain("Exit code: 1");
    expect(report).toContain("truncated");
    expect(report).toContain("(no output)");
  });

  it("cannot be broken out of by backticks in output", () => {
    const report = markdownReport({
      ...base,
      validationResults: [{ command: "x", status: "passed", output: "```\n# Fake heading\n```" }],
    });
    expect(report).toContain("````\n```\n# Fake heading\n```\n````");
  });

  it("keeps a multi-line command on one heading line", () => {
    const report = markdownReport({
      ...base,
      validationResults: [{ command: "a\n## injected", status: "rejected", output: "no" }],
    });
    expect(report).not.toMatch(/^## injected/m);
  });
});

describe("markdownReport filename safety", () => {
  it("cannot be manipulated by Markdown or backticks in file paths", () => {
    const report = markdownReport({
      repositoryPath: "/work/sample",
      changedFiles: [
        { path: "evil`\n## Injected heading\n[click](http://x)", status: "added" },
        { path: "**bold** _it_ <b>x</b>", status: "modified" },
      ],
      validationResults: [],
    });
    expect(report).not.toMatch(/^## Injected heading/m);
    expect(report).not.toContain("[click](");
    expect(report).not.toContain("<b>");
    const bullets = report.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(2);
    for (const bullet of bullets) expect(bullet).toMatch(/\((added|modified)\)$/);
  });

  it("shows tool diagnostics separately from output", () => {
    const report = markdownReport({
      repositoryPath: "/r",
      changedFiles: [],
      validationResults: [{ command: "x", status: "timed_out", output: "", message: "Command timed out after 5 ms" }],
    });
    expect(report).toContain("Note: Command timed out after 5 ms");
  });
});

describe("markdownReport changed files section", () => {
  const none = { validationResults: [] as never[] };

  it("shows renames as old -> new and escapes both names", () => {
    const report = markdownReport({
      repositoryPath: "/r",
      changedFiles: [{ path: "new_name.ts", oldPath: "old*name.ts", status: "renamed" }],
      ...none,
    });
    expect(report).toContain("old\\*name.ts -> new\\_name.ts (renamed)");
  });

  it("says what the changes were compared against", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const detected = markdownReport({ repositoryPath: "/r", changedFiles: [], base: { label: "origin/main", sha, detected: true }, ...none });
    expect(detected).toContain("Compared against ` origin/main ` (0123456), detected as the default branch.");
    const explicit = markdownReport({ repositoryPath: "/r", changedFiles: [], base: { label: "v1.0", sha, detected: false }, ...none });
    expect(explicit).not.toContain("detected as the default branch");
  });

  it("says so when nothing changed", () => {
    const report = markdownReport({ repositoryPath: "/r", changedFiles: [], ...none });
    expect(report).toContain("## Changed files (0)");
    expect(report).toContain("No changes found.");
  });

  it("caps a very long file list and states how many were left out", () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ path: `f${i}.ts`, status: "modified" as const }));
    const report = markdownReport({ repositoryPath: "/r", changedFiles: many, ...none });
    expect(report).toContain("## Changed files (1000)");
    expect(report).toContain("... and 800 more files not shown.");
    expect(report.split("\n").filter((l) => l.endsWith("(modified)"))).toHaveLength(200);
  });
});

describe("markdownReport terminal safety", () => {
  it("removes colour codes from command output and shows other control characters as ?", () => {
    const report = markdownReport({
      repositoryPath: "/r",
      changedFiles: [],
      validationResults: [
        { command: "x", status: "failed", output: "\u001b[31mred error\u001b[0m\r\nline2\u0007bell\ttab" },
      ],
    });
    expect(report).not.toContain("\u001b");
    expect(report).not.toContain("\u0007");
    expect(report).not.toContain("\r");
    expect(report).toContain("red error\nline2?bell\ttab");
  });

  it("flattens escape codes and newlines in file names and the repository path", () => {
    const report = markdownReport({
      repositoryPath: "/r\u001b[2Jx",
      changedFiles: [{ path: "bad\u001b[31m\nname\u0000.txt", status: "added" }],
      validationResults: [],
    });
    expect(report).not.toContain("\u001b");
    expect(report).not.toContain("\u0000");
    expect(report.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });

  it("keeps ordinary text, unicode and tabs untouched", () => {
    const report = markdownReport({
      repositoryPath: "/r",
      changedFiles: [],
      validationResults: [{ command: "x", status: "passed", output: "ünïcödé ✓\tok" }],
    });
    expect(report).toContain("ünïcödé ✓\tok");
  });
});