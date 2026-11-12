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