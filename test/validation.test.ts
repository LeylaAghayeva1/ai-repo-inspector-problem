import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_COMMANDS, parseCommand, runValidation, runValidations } from "../src/validation.js";

const cwd = process.cwd();

describe("parseCommand", () => {
  it("splits plain and quoted arguments without a shell", () => {
    expect(parseCommand(`node -e "console.log('a b')"`)).toEqual(["node", "-e", "console.log('a b')"]);
  });

  it.each([["echo hi; rm -rf x"], ["a && b"], ["a | b"], ["echo $(whoami)"], ["echo `id`"], ["a > out.txt"]])(
    "rejects shell operators: %s",
    (command) => {
      expect(() => parseCommand(command)).toThrow(/not allowed/);
    },
  );

  it("rejects empty, too long and unterminated input", () => {
    expect(() => parseCommand("   ")).toThrow();
    expect(() => parseCommand("a".repeat(501))).toThrow(/longer/);
    expect(() => parseCommand(`node "oops`)).toThrow(/Unterminated/);
  });
});

describe("runValidation", () => {
  const marker = join(tmpdir(), "inspector-injection-marker");
  afterEach(() => rmSync(marker, { force: true }));

  it("reports a passing command", async () => {
    const result = await runValidation(`node -e "console.log('ok')"`, cwd);
    expect(result.status).toBe("passed");
    expect(result.output).toContain("ok");
  });

  it("reports a failing command as failed instead of throwing", async () => {
    const result = await runValidation(`node -e "console.error('boom'); process.exit(3)"`, cwd);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("boom");
  });

  it("does not execute injected shell commands", async () => {
    const result = await runValidation(`echo hi; touch ${marker}`, cwd);
    expect(result.status).toBe("rejected");
    expect(existsSync(marker)).toBe(false);
  });

  it("does not pass secrets from the parent environment", async () => {
    process.env.FAKE_API_KEY = "sk-secret-123";
    try {
      const result = await runValidation(
        `node -e "console.log(process.env.FAKE_API_KEY ?? 'absent')"`,
        cwd,
      );
      expect(result.output).toContain("absent");
      expect(result.output).not.toContain("sk-secret-123");
    } finally {
      delete process.env.FAKE_API_KEY;
    }
  });

  it("kills a command that runs too long", async () => {
    const result = await runValidation(`node -e "setTimeout(() => {}, 60000)"`, cwd, { timeoutMs: 300 });
    expect(result.status).toBe("timed_out");
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it("caps and marks large output", async () => {
    const result = await runValidation(`node -e "console.log('x'.repeat(200000))"`, cwd, {
      maxOutputBytes: 1000,
    });
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(1000);
  });

  it("enforces an executable allowlist", async () => {
    const result = await runValidation(`node -e "1"`, cwd, { allowedExecutables: ["npm"] });
    expect(result.status).toBe("rejected");
  });

  it("returns failed for a missing executable", async () => {
    const result = await runValidation("definitely-not-a-real-command", cwd);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("Could not start");
  });
});

describe("runValidations", () => {
  it("rejects too many commands", async () => {
    await expect(runValidations(Array(MAX_COMMANDS + 1).fill("node -v"), cwd)).rejects.toThrow(/Too many/);
  });

  it("rejects a path that is not a directory", async () => {
    await expect(runValidations(["node -v"], "/no/such/dir")).rejects.toThrow(/not a directory/);
  });

  it("keeps going after a failure so the report is complete", async () => {
    const results = await runValidations([`node -e "process.exit(1)"`, "node -v"], cwd);
    expect(results.map((r) => r.status)).toEqual(["failed", "passed"]);
  });
});

describe("hardening round 2", () => {
  it("rejects newlines even inside quotes", async () => {
    const result = await runValidation(`node -e "console.log(1)\nconsole.log(2)"`, cwd);
    expect(result.status).toBe("rejected");
  });

  it("rejects NUL inside quotes without throwing", async () => {
    const result = await runValidation(`node -e "a\u0000b"`, cwd);
    expect(result.status).toBe("rejected");
  });

  it.each([[{ timeoutMs: -1 }], [{ timeoutMs: 0 }], [{ maxOutputBytes: -1 }], [{ maxOutputBytes: NaN }]])(
    "rejects invalid options %j",
    async (options) => {
      const result = await runValidation("node -v", cwd, options);
      expect(result.status).toBe("rejected");
      expect(result.output).toMatch(/Invalid options/);
    },
  );

  it("rejects allowlist entries that are paths", async () => {
    const result = await runValidation("node -v", cwd, { allowedExecutables: ["/usr/bin/node"] });
    expect(result.status).toBe("rejected");
  });
});

describe("hardening round 3", () => {
  it("rejects an empty executable name without throwing", async () => {
    const result = await runValidation('"" argument', cwd);
    expect(result.status).toBe("rejected");
    expect(result.output).toMatch(/empty/i);
  });

  it("rejects an invalid working directory passed directly", async () => {
    const result = await runValidation("node -v", "/no/such/dir");
    expect(result.status).toBe("rejected");
    expect(result.output).toMatch(/not a directory/);
  });

  it.each([["lower-case"], ["1BAD"], ["A B"], ["API_KEY"], ["GITHUB_TOKEN"], ["DB_PASSWORD"]])(
    "rejects unsafe extraEnvNames entry %s",
    async (name) => {
      const result = await runValidation("node -v", cwd, { extraEnvNames: [name] });
      // "lower-case" has a hyphen (invalid), the others are invalid or secret-looking
      expect(result.status).toBe("rejected");
    },
  );

  it("passes through a harmless, valid extra variable", async () => {
    process.env.INSPECTOR_MODE = "fast";
    try {
      const result = await runValidation(`node -e "console.log(process.env.INSPECTOR_MODE)"`, cwd, {
        extraEnvNames: ["INSPECTOR_MODE"],
      });
      expect(result.output).toContain("fast");
    } finally {
      delete process.env.INSPECTOR_MODE;
    }
  });

  it("kills grandchild processes on timeout", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "inspector-gc-"));
    const marker = join(dir, "grandchild-ran");
    const script = join(dir, "parent.js");
    writeFileSync(
      script,
      `const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'x'), 1500)", ${JSON.stringify(marker)}], { stdio: "ignore" });
setTimeout(() => {}, 60000);`,
    );
    try {
      const result = await runValidation(`node ${script}`, cwd, { timeoutMs: 400 });
      expect(result.status).toBe("timed_out");
      await new Promise((r) => setTimeout(r, 2200));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps output within the cap when a timeout also happens", async () => {
    const result = await runValidation(
      `node -e "process.stdout.write('x'.repeat(5000)); setTimeout(() => {}, 60000)"`,
      cwd,
      { timeoutMs: 500, maxOutputBytes: 1000 },
    );
    expect(result.status).toBe("timed_out");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1000);
    expect(result.message).toMatch(/timed out/);
  });
});