import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { USAGE, parseArgs, printable, runCli } from "../src/cli.js";
import { runReview } from "../src/core.js";
import { handleReview } from "../src/mcp-tools.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(prefix: string, name = ""): string {
  const base = mkdtempSync(join(tmpdir(), `inspector-cli-${prefix}-`));
  dirs.push(base);
  if (!name) return realpathSync(base);
  const nested = join(base, name);
  mkdirSync(nested);
  return realpathSync(nested);
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });

/** Repo on branch `feature`: a.txt modified (committed), w.txt untracked. `testScript` is its npm test. */
function makeRepo(testScript = "node -e 0", dirName = ""): string {
  const repo = tmp("repo", dirName);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { test: testScript } }));
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "a.txt"), "two\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change");
  writeFileSync(join(repo, "w.txt"), "wip\n");
  return repo;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) }, out, err };
}

async function cli(...argv: string[]) {
  const c = capture();
  const code = await runCli(argv, c.io);
  return { code, stdout: c.out.join(""), stderr: c.err.join("") };
}

const errorOf = (...argv: string[]) => {
  const r = parseArgs(argv);
  return r.kind === "error" ? r.message : `(not an error: ${r.kind})`;
};

describe("parseArgs", () => {
  it("accepts the minimal command and applies defaults", () => {
    expect(parseArgs(["review", "--repo", "./x"])).toEqual({
      kind: "run",
      args: { repositoryPath: "./x", baseRef: undefined, validations: [], format: "markdown", output: "review-report.md" },
    });
  });

  it("keeps spaces in the repo path (the starter cut it at the first space)", () => {
    const r = parseArgs(["review", "--repo", "/home/me/my projects/repo one"]);
    expect(r.kind === "run" && r.args.repositoryPath).toBe("/home/me/my projects/repo one");
  });

  it("accepts --option=value, repeated --validate, and every option together", () => {
    const r = parseArgs(["review", "--repo=/r", "--base-ref=origin/main", "--validate", "npm test", "--validate=npm run build", "--format", "markdown", "--output", "out.md"]);
    expect(r).toEqual({
      kind: "run",
      args: { repositoryPath: "/r", baseRef: "origin/main", validations: ["npm test", "npm run build"], format: "markdown", output: "out.md" },
    });
  });

  it("allows '-' as the output and HEAD~1 as the base", () => {
    const r = parseArgs(["review", "--repo", "/r", "--output", "-", "--base-ref", "HEAD~1"]);
    expect(r.kind === "run" && [r.args.output, r.args.baseRef]).toEqual(["-", "HEAD~1"]);
  });

  it("shows help for -h and --help, even with other arguments", () => {
    expect(parseArgs(["--help"]).kind).toBe("help");
    expect(parseArgs(["review", "-h"]).kind).toBe("help");
  });

  it("treats -h as a VALUE when an option is consuming it, not as a help request", () => {
    const r = parseArgs(["review", "--repo", "/r", "--validate", "-h"]);
    expect(r.kind === "run" && r.args.validations).toEqual(["-h"]);
    const o = parseArgs(["review", "--repo", "-h"]);
    expect(o.kind === "run" && o.args.repositoryPath).toBe("-h");
  });

  it("does not treat a value given with = as help", () => {
    const r = parseArgs(["review", "--repo=--help"]);
    expect(r.kind === "run" && r.args.repositoryPath).toBe("--help");
    const v = parseArgs(["review", "--repo", "/r", "--validate=-h", "--output=--help"]);
    expect(v.kind).toBe("run");
  });

  it.each([
    [["--help"]],
    [["-h"]],
    [["-h", "review"]],
    [["review", "--repo", "/r", "-h"]],
    [["review", "--repo", "--help"]],
    [["review", "--repo", "/r", "--output", "--help"]],
    [["review", "--bogus", "--help"]],
  ])("shows help for %j", (argv) => {
    expect(parseArgs(argv).kind).toBe("help");
  });

  it("does not let a consumed option value hide a real later help request", () => {
    expect(parseArgs(["review", "--validate", "-h", "--help"]).kind).toBe("help");
  });

  it.each([
    [[], /Missing command/],
    [["inspect", "--repo", "/r"], /Unknown command "inspect"/],
    [["review"], /--repo is required/],
    [["review", "--repo"], /--repo needs a value/],
    [["review", "--repo", "--format", "markdown"], /--repo needs a value/],
    [["review", "--repo", ""], /--repo must not be empty/],
    [["review", "--repo", "  "], /must not be empty/],
    [["review", "--repo", "/a", "--repo", "/b"], /--repo was given more than once/],
    [["review", "--repo", "/r", "--bogus"], /Unknown option "--bogus"/],
    [["review", "--repo", "/r", "--bas-ref", "main"], /Unknown option "--bas-ref"/],
    [["review", "--repo", "/r", "stray"], /Unexpected argument "stray"/],
    [["review", "--repo", "/r", "--validate"], /--validate needs a value/],
    [["review", "--repo", "/r", "--validate="], /--validate must not be empty/],
    [["review", "--repo", "/r", "--output"], /--output needs a value/],
  ] as [string[], RegExp][])("rejects %j", (argv, message) => {
    expect(errorOf(...argv)).toMatch(message);
  });

  it("rejects json with a clear message, and any other format", () => {
    expect(errorOf("review", "--repo", "/r", "--format", "json")).toMatch(/json is not supported yet/);
    expect(errorOf("review", "--repo", "/r", "--format", "xml")).toMatch(/must be "markdown"/);
  });

  it.each(["--output=/tmp/x", "main;id", "a..b", "$(id)", "a b"])("rejects the unsafe --base-ref %j", (ref) => {
    expect(errorOf("review", "--repo", "/r", `--base-ref=${ref}`)).toMatch(/Invalid --base-ref/);
  });

  it("rejects more than 10 --validate commands", () => {
    const many = Array.from({ length: 11 }, () => ["--validate", "node -v"]).flat();
    expect(errorOf("review", "--repo", "/r", ...many)).toMatch(/Too many --validate/);
  });

  it("documents exit codes in the usage text", () => {
    for (const code of ["0 ", "1 ", "2 ", "3 "]) expect(USAGE).toContain(`  ${code}`);
  });
});

describe("runCli behaviour and exit codes", () => {
  it("writes the report to --output and exits 0", async () => {
    const repo = makeRepo();
    const out = join(tmp("out"), "report.md");
    const r = await cli("review", "--repo", repo, "--base-ref", "main", "--output", out);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Review report written to ${out}`);
    const report = readFileSync(out, "utf8");
    expect(report).toContain("a.txt (modified)");
    expect(report).toContain("w.txt (untracked)");
  });

  it("prints the report to stdout for --output -, and writes no file", async () => {
    const repo = makeRepo();
    const r = await cli("review", "--repo", repo, "--output", "-");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("# Review Report");
    expect(r.stdout).not.toContain("Review report written");
  });

  it("works when the repository path contains spaces", async () => {
    const repo = makeRepo("node -e 0", "my project folder");
    const r = await cli("review", "--repo", repo, "--output", "-");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("a.txt (modified)");
  });

  it("exits 1 when a validation command fails, but still writes the full report", async () => {
    const repo = makeRepo("node -e process.exit(1)");
    const r = await cli("review", "--repo", repo, "--validate", "npm test", "--output", "-");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("FAILED");
    expect(r.stdout).toContain("a.txt (modified)");
    expect(r.stderr).toContain("1 of 1 validation command(s) did not pass");
  });

  it("exits 0 when every validation command passes", async () => {
    const repo = makeRepo();
    const r = await cli("review", "--repo", repo, "--validate", "npm test", "--validate", "node -v", "--output", "-");
    expect(r.code).toBe(0);
    expect(r.stdout.match(/Status: \*\*PASSED\*\*/g)).toHaveLength(2);
  });

  it("exits 1 for a rejected command (shell operators are not allowed)", async () => {
    const repo = makeRepo();
    const marker = join(tmp("m"), "ran");
    const r = await cli("review", "--repo", repo, "--validate", `echo hi; touch ${marker}`, "--output", "-");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("REJECTED");
    expect(existsSync(marker)).toBe(false);
  });

  it("exits 2 for usage errors and 3 for repository problems, with one clean line and no stack", async () => {
    const usage = await cli("review", "--repo", "/r", "--bogus");
    expect(usage.code).toBe(2);
    expect(usage.stderr).toMatch(/^Error: Unknown option "--bogus"\./);

    const notRepo = await cli("review", "--repo", tmp("plain"), "--output", "-");
    expect(notRepo.code).toBe(3);
    expect(notRepo.stderr).toMatch(/^Error: Not a Git working tree/);

    const missing = await cli("review", "--repo", "/no/such/dir");
    expect(missing.code).toBe(3);

    for (const r of [usage, notRepo, missing]) {
      expect(r.stderr).not.toMatch(/\n\s+at /);
      expect(r.stderr).not.toContain("Fatal error");
    }
  });

  it("reports an unknown base ref with exit 3 and starts no validation command", async () => {
    const repo = makeRepo();
    const marker = join(tmp("m2"), "ran");
    const r = await cli("review", "--repo", repo, "--base-ref", "nope", "--validate", `node -e "require('fs').writeFileSync('${marker}','x')"`);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Base ref "nope" was not found in this repository');
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses an injected --base-ref (exit 2) and creates no file", async () => {
    const repo = makeRepo();
    const marker = join(tmp("m3"), "pwned");
    const r = await cli("review", "--repo", repo, `--base-ref=--output=${marker}`);
    expect(r.code).toBe(2);
    expect(existsSync(marker)).toBe(false);
  });

  it("exits 3 with a readable message when the report file cannot be written", async () => {
    const repo = makeRepo();
    const r = await cli("review", "--repo", repo, "--output", join(tmp("x"), "no-such-dir", "r.md"));
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^Error: ENOENT/);
  });

  it("prints a path containing a newline and terminal escape codes as ONE safe line", async () => {
    const base = tmp("evil");
    const evil = join(base, "evil\nINJECTED LINE\u001b[31mRED");
    mkdirSync(evil);
    const r = await cli("review", "--repo", evil, "--output", "-");
    expect(r.code).toBe(3);
    expect(r.stderr.split("\n").filter((l) => l.startsWith("Error:"))).toHaveLength(1);
    expect(r.stderr).not.toContain("\u001b");
    expect(r.stderr).not.toMatch(/^INJECTED LINE/m);
    expect(r.stderr).toContain("\\n");
    expect(r.stderr).toContain("\\x1b");
  });

  it("runs the command '-h' when --validate is given -h (does not show help)", async () => {
    const repo = makeRepo();
    const r = await cli("review", "--repo", repo, "--validate", "-h", "--output", "-");
    expect(r.stdout).not.toContain("Usage: inspector");
    expect(r.stdout).toContain("# Review Report");
    expect(r.code).toBe(1); // "-h" is not a program, so the check is reported as failed
  });

  it("prints help with exit 0", async () => {
    const r = await cli("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: inspector review");
  });
});

describe("core refuses formats it cannot produce", () => {
  it("rejects json instead of silently ignoring it (the CLI and library behave the same)", async () => {
    const repo = makeRepo();
    await expect(runReview({ repositoryPath: repo, format: "json" as never })).rejects.toThrow(/Unsupported format "json"/);
  });
});

describe.skipIf(process.platform === "win32")("the real program (separate process)", () => {
  const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
  const entry = join(process.cwd(), "src", "cli.ts");
  const run = (cwd: string, ...args: string[]) => spawnSync(tsx, [entry, ...args], { cwd, encoding: "utf8" });

  it("exits 2 on bad usage and prints nothing to stdout", () => {
    const r = run(tmp("cwd"), "review", "--repo");
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--repo needs a value");
  });

  it("writes review-report.md in the current folder by default, for a path with spaces", () => {
    const repo = makeRepo("node -e 0", "path with spaces");
    const cwd = tmp("cwd2");
    const r = run(cwd, "review", "--repo", repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Review report written to review-report.md");
    expect(readFileSync(join(cwd, "review-report.md"), "utf8")).toContain("a.txt (modified)");
  });

  it("returns the validation exit code (1) from the real process", () => {
    const repo = makeRepo("node -e process.exit(1)");
    const r = run(tmp("cwd3"), "review", "--repo", repo, "--validate", "npm test");
    expect(r.status).toBe(1);
  });
});

describe("CLI and MCP stay consistent", () => {
  const normalize = (report: string) => report.replace(/Duration: \d+ ms/g, "Duration: N ms");

  async function both(repo: string, extra: { cliChecks: string[]; mcpChecks: ("test" | "typecheck" | "build" | "lint")[] }) {
    const viaCli = await cli("review", "--repo", repo, "--base-ref", "main", ...extra.cliChecks.flatMap((c) => ["--validate", c]), "--output", "-");
    const viaMcp = await handleReview({ repo_path: repo, base_ref: "main", checks: extra.mcpChecks });
    return { viaCli, viaMcp, mcpText: viaMcp.content[0].text };
  }

  it("produce the same report for the same repository and base", async () => {
    const repo = makeRepo();
    const { viaCli, mcpText } = await both(repo, { cliChecks: [], mcpChecks: [] });
    expect(viaCli.code).toBe(0);
    expect(normalize(viaCli.stdout.trimEnd())).toBe(normalize(mcpText));
  });

  it("produce the same report with a named check (npm test), apart from timings", async () => {
    const repo = makeRepo();
    const { viaCli, mcpText } = await both(repo, { cliChecks: ["npm test"], mcpChecks: ["test"] });
    expect(normalize(viaCli.stdout.trimEnd())).toBe(normalize(mcpText));
    expect(mcpText).toContain("PASSED");
  });

  it("report a failing check the same way (CLI also sets exit code 1; MCP leaves the call successful)", async () => {
    const repo = makeRepo("node -e process.exit(1)");
    const { viaCli, viaMcp, mcpText } = await both(repo, { cliChecks: ["npm test"], mcpChecks: ["test"] });
    expect(viaCli.code).toBe(1);
    expect(viaMcp.isError).toBeUndefined();
    expect(normalize(viaCli.stdout.trimEnd())).toBe(normalize(mcpText));
    expect(mcpText).toContain("FAILED");
  });

  it("use the same default-branch detection when no base is given", async () => {
    const repo = makeRepo();
    const c = await cli("review", "--repo", repo, "--output", "-");
    const m = await handleReview({ repo_path: repo });
    expect(c.stdout).toContain("detected as the default branch");
    expect(normalize(c.stdout.trimEnd())).toBe(normalize(m.content[0].text));
  });

  it("both refuse the same unknown base ref with the same explanation", async () => {
    const repo = makeRepo();
    const c = await cli("review", "--repo", repo, "--base-ref", "nope");
    const m = await handleReview({ repo_path: repo, base_ref: "nope" });
    expect(c.code).toBe(3);
    expect(m.isError).toBe(true);
    const sentence = 'Base ref "nope" was not found in this repository.';
    expect(c.stderr).toContain(sentence);
    expect(m.content[0].text).toContain(sentence);
  });

  it("both refuse a missing directory", async () => {
    const c = await cli("review", "--repo", "/no/such/dir");
    const m = await handleReview({ repo_path: "/no/such/dir" });
    expect(c.code).toBe(3);
    expect(m.isError).toBe(true);
  });
});

describe("printable", () => {
  it("escapes control characters and shortens very long text", () => {
    expect(printable("a\nb\tc\rd\u001be\u0000f\u007f")).toBe("a\\nb\\tc\\rd\\x1be\\x00f\\x7f");
    expect(printable("x".repeat(600))).toHaveLength(503);
    expect(printable("normal text, ünïcödé fine")).toBe("normal text, ünïcödé fine");
  });
});

describe("names that pass the input filter but are not valid Git refs", () => {
  it.each(["a.lock", "feat/.x", "x.", "a/b.lock"])("%s gets a clean 'not found' error from Git's own check", async (ref) => {
    const repo = makeRepo();
    const r = await cli("review", "--repo", repo, "--base-ref", ref);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("was not found in this repository");
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});