import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { conciseError, createServer, redactPaths, resolveRepositoryPath, reviewInputShape } from "../src/mcp-tools.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

function makeRepo(testScript: string): string {
  const dir = mkdtempSync(join(tmpdir(), "inspector-mcp-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: testScript } }));
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.txt"), "two\n");
  writeFileSync(join(dir, "b.txt"), "new\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "change");
  return dir;
}

let client: Client;
const cleanup: string[] = [];

beforeAll(async () => {
  const server = createServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientSide);
});
afterAll(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function call(args: Record<string, unknown>) {
  try {
    const result = (await client.callTool({ name: "review_repository", arguments: args })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    return { isError: Boolean(result.isError), text: result.content.map((c) => c.text).join("\n") };
  } catch (error) {
    return { isError: true, text: String(error) }; // protocol-level validation error
  }
}

describe("MCP contract", () => {
  it("does not claim the tool is harmless: named npm scripts can write files and use the network", async () => {
    const { tools } = await client.listTools();
    const hints = tools.find((t) => t.name === "review_repository")!.annotations;
    expect(hints?.readOnlyHint).toBe(false);
    expect(hints?.destructiveHint).not.toBe(false);
    expect(hints?.openWorldHint).not.toBe(false);
  });

  it("advertises repo_path, base_ref and named checks, and no free-form commands", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "review_repository");
    expect(tool).toBeDefined();
    const props = Object.keys((tool!.inputSchema as { properties: object }).properties);
    expect(props.sort()).toEqual(["base_ref", "checks", "repo_path"]);
    expect(tool!.description).toMatch(/untrusted/i);
    expect((tool!.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });

  it("actually uses repo_path (the original handler read the wrong name)", async () => {
    const repo = makeRepo("node -e 0");
    cleanup.push(repo);
    const { isError, text } = await call({ repo_path: repo, base_ref: "main" });
    expect(isError).toBe(false);
    expect(text).toContain("a.txt");
    expect(text).toContain("b.txt");
  });

  it("runs a named check and reports a passing result", async () => {
    const repo = makeRepo("node -e 0");
    cleanup.push(repo);
    const { isError, text } = await call({ repo_path: repo, base_ref: "main", checks: ["test"] });
    expect(isError).toBe(false);
    expect(text).toContain("npm test");
    expect(text).toContain("PASSED");
  });

  it("reports a failing check in the report instead of failing the whole call", async () => {
    const repo = makeRepo("node -e process.exit(1)");
    cleanup.push(repo);
    const { isError, text } = await call({ repo_path: repo, base_ref: "main", checks: ["test"] });
    expect(isError).toBe(false);
    expect(text).toContain("FAILED");
    expect(text).toContain("b.txt");
  });
});

describe("MCP trust boundary", () => {
  it("rejects an unknown check name", async () => {
    const repo = makeRepo("node -e 0");
    cleanup.push(repo);
    const { isError } = await call({ repo_path: repo, checks: ["rm -rf /"] });
    expect(isError).toBe(true);
  });

  it("rejects free-form command arguments explicitly and never runs them", async () => {
    const repo = makeRepo("node -e 0");
    cleanup.push(repo);
    const marker = join(tmpdir(), "inspector-mcp-marker");
    rmSync(marker, { force: true });
    const { isError } = await call({ repo_path: repo, base_ref: "main", validationCommands: [`touch ${marker}`] });
    expect(isError).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it.each([["--output=/tmp/x"], ["-h"], ["main;id"], ["a b"], [""]])("rejects base_ref %j", async (ref) => {
    const repo = makeRepo("node -e 0");
    cleanup.push(repo);
    const { isError } = await call({ repo_path: repo, base_ref: ref });
    expect(isError).toBe(true);
  });

  it("returns a tool error for a missing directory instead of crashing", async () => {
    const { isError, text } = await call({ repo_path: "/no/such/repo" });
    expect(isError).toBe(true);
    expect(text).toMatch(/not an existing directory/);
  });

  it("enforces INSPECTOR_ALLOWED_ROOTS", () => {
    const repo = makeRepo("node -e 0");
    const other = mkdtempSync(join(tmpdir(), "inspector-root-"));
    cleanup.push(repo, other);
    expect(() => resolveRepositoryPath(repo, { INSPECTOR_ALLOWED_ROOTS: other })).toThrow(/outside/);
    expect(resolveRepositoryPath(repo, { INSPECTOR_ALLOWED_ROOTS: tmpdir() })).toBeTruthy();
    expect(resolveRepositoryPath(repo, {})).toBeTruthy();
  });

  it("does not treat a sibling directory with a shared prefix as inside an allowed root", () => {
    const root = mkdtempSync(join(tmpdir(), "inspector-pfx-"));
    const sibling = root + "-evil";
    mkdirSync(sibling);
    cleanup.push(root, sibling);
    expect(() => resolveRepositoryPath(sibling, { INSPECTOR_ALLOWED_ROOTS: root })).toThrow(/outside/);
  });
});

describe("base_ref contract", () => {
  const schema = z.strictObject(reviewInputShape);
  const ok = (ref: string) => schema.safeParse({ repo_path: "/r", base_ref: ref }).success;

  it.each([["main"], ["origin/main"], ["v1.0"], ["feature/new-feature"], ["HEAD~1"], ["HEAD^"], ["HEAD~2^"], ["a1b2c3d"]])(
    "accepts %s",
    (ref) => expect(ok(ref)).toBe(true),
  );

  it.each([["main..evil"], ["a/../b"], ["a//b"], ["main/"], ["--output=x"], ["-x"], ["main@{upstream}"], ["a b"], ["main;id"], [""]])(
    "rejects %j before Git is ever run",
    (ref) => expect(ok(ref)).toBe(false),
  );

  it("rejects an empty repo_path", () => {
    expect(schema.safeParse({ repo_path: "" }).success).toBe(false);
  });
});

describe("path restrictions in depth", () => {
  it("rejects a symlink inside an allowed root that points outside it", () => {
    const root = mkdtempSync(join(tmpdir(), "inspector-allowed-"));
    const outside = mkdtempSync(join(tmpdir(), "inspector-outside-"));
    cleanup.push(root, outside);
    const link = join(root, "sneaky");
    symlinkSync(outside, link);
    expect(() => resolveRepositoryPath(link, { INSPECTOR_ALLOWED_ROOTS: root })).toThrow(/outside/);
  });

  it("accepts a root given with a trailing slash and multiple roots", () => {
    const rootA = mkdtempSync(join(tmpdir(), "inspector-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "inspector-b-"));
    const inB = join(rootB, "repo");
    mkdirSync(inB);
    cleanup.push(rootA, rootB);
    expect(resolveRepositoryPath(inB, { INSPECTOR_ALLOWED_ROOTS: `${rootA}${delimiter}${rootB}/` })).toBeTruthy();
  });

  it("can require allowed roots to be configured", () => {
    expect(() => resolveRepositoryPath(tmpdir(), { INSPECTOR_REQUIRE_ALLOWED_ROOTS: "1" })).toThrow(/requires/);
  });
});

describe("MCP behaviour end to end", () => {
  it("runs a duplicate check only once", async () => {
    const repo = makeRepo("node -e 0");
    cleanup.push(repo);
    const { text } = await call({ repo_path: repo, base_ref: "main", checks: ["test", "test"] });
    expect(text.match(/### .*npm test/g)).toHaveLength(1);
  });

  it("reports a repository with no matching npm script as FAILED without crashing", async () => {
    const repo = makeRepo("node -e 0");
    cleanup.push(repo);
    const { isError, text } = await call({ repo_path: repo, base_ref: "main", checks: ["lint"] });
    expect(isError).toBe(false);
    expect(text).toContain("FAILED");
  });

  it("keeps huge command output small and marks it truncated", async () => {
    const repo = makeRepo(`node -e "console.log('x'.repeat(200000))"`);
    cleanup.push(repo);
    const { text } = await call({ repo_path: repo, base_ref: "main", checks: ["test"] });
    expect(text).toContain("truncated");
    expect(text.length).toBeLessThan(25_000);
  });

  it("gives the agent a short, actionable Git error without usage hints", async () => {
    const repo = makeRepo("node -e 0");
    cleanup.push(repo);
    const { isError, text } = await call({ repo_path: repo, base_ref: "does-not-exist" });
    expect(isError).toBe(true);
    expect(text).toContain("was not found in this repository");
    expect(text).not.toContain("Use '--'");
    expect(text.split("\n").length).toBeLessThanOrEqual(2);
  });
});

describe("error text helpers", () => {
  it("redacts known paths (defensive: no current Git error includes one)", () => {
    expect(redactPaths("failed in /srv/secret/repo/x", ["/srv/secret/repo"])).toBe("failed in <repo>/x");
  });

  it("keeps only the fatal line of a Git error", () => {
    expect(conciseError(new Error("Command failed: git diff\nfatal: bad revision\nUse '--' to separate"))).toBe(
      "fatal: bad revision",
    );
    expect(conciseError(new Error("something else"))).toBe("something else");
  });
});