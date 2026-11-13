import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { reviewRepository } from "../src/core.js";
import { GitError, changedFiles, inspectChanges, isSafeBaseRef } from "../src/git.js";
import type { ChangedFile } from "../src/types.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `inspector-git-${prefix}-`));
  dirs.push(dir);
  return dir;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
  });

function write(repo: string, path: string, content: string) {
  const full = join(repo, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function commitAll(repo: string, message: string) {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

/** main has a.txt, b.txt, keep.txt; returns the repo on a clean main. */
function baseRepo(branch = "main"): string {
  const repo = tmp("repo");
  git(repo, "init", "-q", "-b", branch);
  write(repo, "a.txt", "one\n");
  write(repo, "b.txt", "to be deleted\nwith some lines\nso it is similar\n");
  write(repo, "keep.txt", "unchanged\n");
  commitAll(repo, "init");
  return repo;
}

const byPath = (files: ChangedFile[]) => Object.fromEntries(files.map((f) => [f.path, f])) as Record<string, ChangedFile>;

describe("isSafeBaseRef", () => {
  it.each(["main", "origin/main", "v1.0", "feature/new-feature", "HEAD", "HEAD~1", "HEAD^", "HEAD~2^", "a1b2c3d"])(
    "accepts %s",
    (ref) => expect(isSafeBaseRef(ref)).toBe(true),
  );

  it.each(["", "--output=/tmp/x", "-h", "main;id", "a b", "main..evil", "a/../b", "a//b", "main/", "main@{upstream}", "x\ny", "`id`", "$(id)"])(
    "rejects %j",
    (ref) => expect(isSafeBaseRef(ref)).toBe(false),
  );

  it("rejects non-strings and over-long refs", () => {
    expect(isSafeBaseRef(undefined)).toBe(false);
    expect(isSafeBaseRef(42)).toBe(false);
    expect(isSafeBaseRef("a".repeat(201))).toBe(false);
    expect(isSafeBaseRef("a".repeat(200))).toBe(true);
  });
});

describe("what counts as changed", () => {
  it("reports added, modified and deleted commits made since main", () => {
    const repo = baseRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "a.txt", "two\n");
    write(repo, "new.txt", "new\n");
    rmSync(join(repo, "b.txt"));
    commitAll(repo, "change");

    const files = byPath(changedFiles(repo, "main"));
    expect(files["a.txt"].status).toBe("modified");
    expect(files["new.txt"].status).toBe("added");
    expect(files["b.txt"].status).toBe("deleted");
    expect(files["keep.txt"]).toBeUndefined();
  });

  it("detects a rename and remembers the old path", () => {
    const repo = baseRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    renameSync(join(repo, "b.txt"), join(repo, "renamed.txt"));
    commitAll(repo, "rename");

    const files = changedFiles(repo, "main");
    expect(files).toEqual([{ path: "renamed.txt", oldPath: "b.txt", status: "renamed" }]);
  });

  it("still detects renames when the repository config turns rename detection off", () => {
    const repo = baseRepo();
    git(repo, "config", "diff.renames", "false");
    git(repo, "checkout", "-q", "-b", "feature");
    renameSync(join(repo, "b.txt"), join(repo, "renamed.txt"));
    commitAll(repo, "rename");

    expect(changedFiles(repo, "main")).toEqual([{ path: "renamed.txt", oldPath: "b.txt", status: "renamed" }]);
  });

  it("KNOWN LIMITATION: an unstaged rename shows as deleted + untracked until the files are staged", () => {
    const repo = baseRepo();
    renameSync(join(repo, "b.txt"), join(repo, "moved.txt")); // plain filesystem rename, nothing staged

    const files = changedFiles(repo, "main");
    expect(files).toEqual([
      { path: "b.txt", status: "deleted" },
      { path: "moved.txt", status: "untracked" },
    ]);

    git(repo, "add", "-A"); // once staged, Git can pair them
    expect(changedFiles(repo, "main")).toEqual([{ path: "moved.txt", oldPath: "b.txt", status: "renamed" }]);
  });

  it("includes staged, unstaged and untracked changes, and leaves ignored files out", () => {
    const repo = baseRepo();
    write(repo, ".gitignore", "ignored.log\nbuild/\n");
    commitAll(repo, "ignore rules");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "a.txt", "staged edit\n");
    git(repo, "add", "a.txt");
    write(repo, "keep.txt", "unstaged edit\n");
    write(repo, "brand-new.txt", "untracked\n");
    write(repo, "ignored.log", "noise\n");
    write(repo, "build/out.js", "noise\n");

    const files = byPath(changedFiles(repo, "main"));
    expect(files["a.txt"].status).toBe("modified");
    expect(files["keep.txt"].status).toBe("modified");
    expect(files["brand-new.txt"].status).toBe("untracked");
    expect(files["ignored.log"]).toBeUndefined();
    expect(files["build/out.js"]).toBeUndefined();
  });

  it("reports a file that was committed and then edited again only once, with its net status", () => {
    const repo = baseRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "new.txt", "v1\n");
    commitAll(repo, "add");
    write(repo, "new.txt", "v2 uncommitted\n");

    const matches = changedFiles(repo, "main").filter((f) => f.path === "new.txt");
    expect(matches).toEqual([{ path: "new.txt", status: "added" }]);
  });

  it("returns an empty list when nothing differs", () => {
    const repo = baseRepo();
    expect(changedFiles(repo, "main")).toEqual([]);
  });

  it("returns files in a stable, sorted order", () => {
    const repo = baseRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    for (const name of ["z.txt", "m.txt", "c.txt"]) write(repo, name, "x");
    commitAll(repo, "many");
    const paths = changedFiles(repo, "main").map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
  });

  it.skipIf(process.platform === "win32")("handles awkward file names: spaces, tabs, newlines, quotes and unicode", () => {
    const repo = baseRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    const names = ["has space.txt", "has\ttab.txt", "has\nnewline.txt", 'has"quote.txt', "ünïcödé-файл.txt", "-leading-dash.txt"];
    for (const name of names) write(repo, name, "x");
    commitAll(repo, "odd names");
    write(repo, "untracked\tweird\nname.txt", "x");

    const paths = changedFiles(repo, "main").map((f) => f.path);
    for (const name of [...names, "untracked\tweird\nname.txt"]) expect(paths).toContain(name);
  });

  it("works from a subdirectory and still reports root-relative paths for the whole repository", () => {
    const repo = baseRepo();
    mkdirSync(join(repo, "sub"));
    write(repo, "sub/inner.txt", "x");
    commitAll(repo, "sub");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "sub/inner.txt", "changed");
    write(repo, "a.txt", "changed outside sub");

    const result = inspectChanges(join(repo, "sub"), "main");
    expect(result.files.map((f) => f.path).sort()).toEqual(["a.txt", "sub/inner.txt"]);
  });
});

describe("base ref selection", () => {
  it("detects master when there is no main", () => {
    const repo = baseRepo("master");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "x.txt", "x");
    commitAll(repo, "x");
    const { files, base } = inspectChanges(repo);
    expect(base).toMatchObject({ label: "master", detected: true });
    expect(files.map((f) => f.path)).toEqual(["x.txt"]);
  });

  it("prefers origin/HEAD, so unpushed commits on the default branch count as changes", () => {
    const upstream = baseRepo("main");
    const clone = tmp("clone");
    git(clone, "clone", "-q", upstream, ".");
    write(clone, "local-only.txt", "x");
    commitAll(clone, "local commit on main");

    const { files, base } = inspectChanges(clone);
    expect(base).toMatchObject({ label: "origin/main", detected: true });
    expect(files.map((f) => f.path)).toEqual(["local-only.txt"]);
  });

  it("falls back to the other known default branch names", () => {
    const repo = baseRepo("trunk");
    expect(inspectChanges(repo).base.label).toBe("trunk");
  });

  it("explains how to proceed when no default branch can be found", () => {
    const repo = baseRepo("weird-name");
    expect(() => inspectChanges(repo)).toThrow(/Could not determine the default branch.*Pass a base ref/);
  });

  it("accepts HEAD~1 and a commit hash", () => {
    const repo = baseRepo();
    write(repo, "second.txt", "x");
    commitAll(repo, "second");
    const sha = git(repo, "rev-parse", "HEAD~1").trim();
    expect(changedFiles(repo, "HEAD~1").map((f) => f.path)).toEqual(["second.txt"]);
    expect(changedFiles(repo, sha).map((f) => f.path)).toEqual(["second.txt"]);
    expect(inspectChanges(repo, "HEAD~1").base.sha).toBe(sha);
  });

  it("an explicit base is reported as not detected", () => {
    const repo = baseRepo();
    expect(inspectChanges(repo, "main").base).toMatchObject({ label: "main", detected: false });
  });
});

describe("unsafe or invalid input", () => {
  it("refuses an option-like base ref and never lets Git write the file it names", () => {
    const repo = baseRepo();
    const marker = join(tmp("marker"), "pwned.txt");
    expect(() => changedFiles(repo, `--output=${marker}`)).toThrow(GitError);
    expect(existsSync(marker)).toBe(false);
  });

  it.each(["main;touch /tmp/x", "$(id)", "main..HEAD", "-h"])("refuses base ref %j before running Git", (ref) => {
    const repo = baseRepo();
    expect(() => changedFiles(repo, ref)).toThrow(/Invalid base ref/);
  });

  it("says plainly when the base ref does not exist", () => {
    const repo = baseRepo();
    expect(() => changedFiles(repo, "no-such-branch")).toThrow(/"no-such-branch" was not found in this repository/);
  });

  it("rejects a folder that is not a Git repository", () => {
    expect(() => changedFiles(tmp("plain"), "main")).toThrow(/Not a Git working tree/);
  });

  it("rejects a path that does not exist or is a file", () => {
    expect(() => changedFiles("/no/such/dir", "main")).toThrow(/not a directory/);
    const dir = tmp("file");
    write(dir, "f.txt", "x");
    expect(() => changedFiles(join(dir, "f.txt"), "main")).toThrow(/not a directory/);
  });

  it("reports a repository with no commits instead of a raw Git error", () => {
    const repo = tmp("empty");
    git(repo, "init", "-q", "-b", "main");
    expect(() => changedFiles(repo, "main")).toThrow(/no commits yet/);
  });

  it("reports histories with no common ancestor", () => {
    const repo = baseRepo();
    git(repo, "checkout", "-q", "--orphan", "unrelated");
    git(repo, "rm", "-rfq", ".");
    write(repo, "other.txt", "x");
    commitAll(repo, "unrelated root");
    expect(() => changedFiles(repo, "main")).toThrow(/No common ancestor/);
  });

  it("keeps Git's own usage text out of error messages", () => {
    const repo = baseRepo();
    try {
      changedFiles(repo, "no-such-branch");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("Use '--'");
      expect((error as Error).message.split("\n")).toHaveLength(1);
    }
  });
});

describe("a hostile repository must not run code during inspection", () => {
  it.skipIf(process.platform === "win32")("does not execute core.fsmonitor from the repository's own config", () => {
    const repo = baseRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "a.txt", "changed");
    const marker = join(tmp("fsm"), "fsmonitor-ran");
    const hook = join(tmp("hook"), "hook.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    chmodSync(hook, 0o755);
    git(repo, "config", "core.fsmonitor", hook);

    changedFiles(repo, "main");
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("proves the hook above WOULD run if it were not disabled (so the test is meaningful)", () => {
    const repo = baseRepo();
    write(repo, "a.txt", "changed");
    const marker = join(tmp("fsm2"), "fsmonitor-ran");
    const hook = join(tmp("hook2"), "hook.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    chmodSync(hook, 0o755);
    git(repo, "config", "core.fsmonitor", hook);

    execFileSync("git", ["status", "--porcelain"], { cwd: repo, stdio: "pipe" }); // plain Git, no protection
    expect(existsSync(marker)).toBe(true);
  });
});

describe("reviewRepository integration", () => {
  it("fails on a bad ref BEFORE starting any validation command", async () => {
    const repo = baseRepo();
    const marker = join(tmp("val"), "validation-ran");
    await expect(
      reviewRepository({
        repositoryPath: repo,
        baseRef: "no-such-branch",
        validationCommands: [`node -e "require('fs').writeFileSync('${marker}','x')"`],
      }),
    ).rejects.toThrow(GitError);
    expect(existsSync(marker)).toBe(false);
  });

  it("produces a report with the base, renamed files and uncommitted changes", async () => {
    const repo = baseRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    renameSync(join(repo, "b.txt"), join(repo, "renamed.txt"));
    commitAll(repo, "rename");
    write(repo, "wip.txt", "x");

    const report = await reviewRepository({ repositoryPath: repo });
    expect(report).toContain("Compared against ` main `");
    expect(report).toContain("detected as the default branch");
    expect(report).toContain("b.txt -> renamed.txt (renamed)");
    expect(report).toContain("wip.txt (untracked)");
    expect(report).toContain("## Changed files (2)");
  });
});

describe.skipIf(process.platform === "win32")("Git failures are contained (fake `git` on PATH)", () => {
  function withFakeGit(script: string, env: Record<string, string>, body: (repo: string) => void) {
    const bin = tmp("fakebin");
    const fake = join(bin, "git");
    writeFileSync(fake, `#!/bin/sh\n${script}\n`);
    chmodSync(fake, 0o755);
    const repo = tmp("fakerepo");
    const saved = { PATH: process.env.PATH, ...Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]])) };
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
    Object.assign(process.env, env);
    try {
      body(repo);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("stops a Git process that runs too long and reports a short error", () => {
    withFakeGit("exec sleep 30", { INSPECTOR_GIT_TIMEOUT_MS: "300" }, (repo) => {
      const started = Date.now();
      expect(() => changedFiles(repo, "main")).toThrow(/Git took longer than 0\.3 s and was stopped/);
      expect(Date.now() - started).toBeLessThan(5000);
    });
  });

  it("reports output beyond the buffer limit as 'too many changed files'", () => {
    withFakeGit("yes x | head -c 20000000", {}, (repo) => {
      expect(() => changedFiles(repo, "main")).toThrow(/too many changed files/);
    });
  });

  it("explains Git's 'dubious ownership' refusal", () => {
    withFakeGit(`echo "fatal: detected dubious ownership in repository at '/x'" >&2\nexit 128`, {}, (repo) => {
      expect(() => changedFiles(repo, "main")).toThrow(/owned by a different user \(safe\.directory\)/);
    });
  });

  it("ignores a nonsense INSPECTOR_GIT_TIMEOUT_MS and keeps working", () => {
    const repo = baseRepo();
    for (const bad of ["abc", "-5", "0", "99999999", "1.5"]) {
      const saved = process.env.INSPECTOR_GIT_TIMEOUT_MS;
      process.env.INSPECTOR_GIT_TIMEOUT_MS = bad;
      try {
        expect(changedFiles(repo, "main")).toEqual([]);
      } finally {
        if (saved === undefined) delete process.env.INSPECTOR_GIT_TIMEOUT_MS;
        else process.env.INSPECTOR_GIT_TIMEOUT_MS = saved;
      }
    }
  });
});