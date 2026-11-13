# Repository Inspector

Repository Inspector looks at the changes in a Git repository, can run checks on it (like `npm test`), and writes a Markdown review report.

It has two ways to use it, and both share the same core code:

- **MCP server (primary):** for AI coding agents, over stdio.
- **CLI:** for developers, for reproducing what an agent saw, and for CI.

## Requirements

- Node.js 20 or newer
- Git on your `PATH`

## Install and check that it works

```bash
npm ci
npm run typecheck
npm run build
npm test
```

Expected result: no errors, and `216 passed`.

Notes:
- `npm ci` may print `npm audit` warnings and an `allow-scripts` notice. These come from dev tools and do not affect the inspector. Do not run `npm audit fix --force`.
- Run `npm run build` before using `dist/src/cli.js`.

## CLI

The command is `review`. Use the built file, or `npm run inspector --` while developing:

```bash
node dist/src/cli.js review --repo ./path/to/repository --output -
npm run inspector -- review --repo ./path/to/repository
```

Run checks as part of the review:

```bash
node dist/src/cli.js review --repo ./path/to/repository --output - \
  --validate "npm test" --validate "npm run typecheck"
```

| Option | Meaning |
|---|---|
| `--repo <path>` | Repository to inspect (required). Spaces in the path are fine. |
| `--base-ref <ref>` | Branch, tag or commit to compare against. If missing, the default branch is detected. |
| `--validate <command>` | Command to run. Can be repeated, up to 10 times. |
| `--format markdown` | Only Markdown is supported. |
| `--output <file>` | Where to write the report. Default `review-report.md`. Use `-` to print to the terminal. An existing file is overwritten. |
| `-h`, `--help` | Show help. |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Report written, and all checks passed (or none were requested). |
| 1 | Report written, but at least one check did not pass. |
| 2 | Wrong usage (bad or unknown option). |
| 3 | The repository could not be inspected, or the report could not be written. |

Commands from `--validate` are split into a program and arguments and started **without a shell**. Shell characters such as `;`, `|`, `&&` and `$(...)` are rejected. Each command has a 120-second timeout, a 64 KiB output limit, and a cleaned environment (your secrets are not passed on).

## MCP server

```bash
npm run build
node dist/src/mcp-server.js      # or: npm run mcp-server
```

It offers one tool, `review_repository`:

```json
{
  "repo_path": "/absolute/path/to/repository",
  "base_ref": "main",
  "checks": ["test", "typecheck", "build"]
}
```

- `repo_path` is required and must be an existing directory.
- `base_ref` is optional: a branch, tag or commit (with simple `~N` / `^N`). Ranges and names starting with `-` are rejected.
- `checks` is optional. Allowed values: `test`, `typecheck`, `build`, `lint`. Each one runs the matching `npm` script.
- Any other field is rejected. The agent cannot send its own command text.
- Each check has a 120-second timeout and a 16 KiB output limit.
- The tool is marked `destructiveHint: true` and `openWorldHint: true`, because project scripts can change files and use the network.

### Limiting which folders the MCP server can read

By default any existing directory is accepted. To restrict it:

- `INSPECTOR_ALLOWED_ROOTS`: allowed folders, separated by `:` (macOS/Linux) or `;` (Windows). Symlinks that point outside an allowed folder are rejected.
- `INSPECTOR_REQUIRE_ALLOWED_ROOTS=1`: refuse to run unless at least one allowed folder is set.

## What the inspection covers

- Compares your working tree with the merge base of the base ref and `HEAD`.
- Includes committed, staged, unstaged and untracked (not ignored) changes.
- Handles renames and unusual file names.
- Finds the default branch from `origin/HEAD`, then `main`, `master`, `trunk`, `develop`.
- Lists at most 200 files and says how many were left out.
- Shows each check's status (`PASSED`, `FAILED`, `TIMED_OUT`, `REJECTED`), exit code, duration, whether output was cut, and the output. Output is labelled as untrusted data.

## Environment variables

| Variable | Purpose |
|---|---|
| `INSPECTOR_ALLOWED_ROOTS` | Allowed folders for MCP. |
| `INSPECTOR_REQUIRE_ALLOWED_ROOTS` | `1` = roots must be configured. |
| `INSPECTOR_GIT_TIMEOUT_MS` | Git timeout, 1–300000 ms. Bad values fall back to 30000. |
| `INSPECTOR_DEBUG` | `1` = show a stack trace on CLI errors. |

## Safety

The MCP caller is treated as **untrusted**. Repository content can contain prompt-injection text, so the agent can only pick fixed named checks, and command output is labelled as data, not instructions. The CLI is for a human, so it accepts free-form commands (still without a shell).

**This tool is not a sandbox.** A named check runs the project's own npm script. That script can run any code with the permissions of the user who started the inspector, and may use the network. The `npm`-only rule limits the first program that is started; it does not limit what the script does. For code you do not trust, run the inspector in a container or a low-privilege account.

Git is also hardened: the repository's own `core.fsmonitor` setting (which can run a command during `git status`) is turned off on every Git call, external diff and text-conversion tools are off, and the base ref is turned into a commit hash before it is used.

## How the CLI and MCP differ on purpose

| | CLI | MCP |
|---|---|---|
| Checks | Any command string | Named checks only |
| First program | Any | `npm` only |
| Output limit | 64 KiB | 16 KiB |
| Failed check | Report is written, exit code 1 | Tool call succeeds, report says `FAILED` |
| Naming | `--base-ref` | `base_ref` |

Both call the same inspection and report code, so file lists and report layout are the same for the same request. Tests compare the two reports.

## Known limitations

- No sandbox for project scripts (see above).
- Only tested on Linux (Node 22, Git 2.43) and macOS (Node 24, Git 2.54). Windows is not tested. On Windows, starting `npm` without a shell and stopping child processes probably need extra work.
- A file renamed on disk but not yet staged shows as a deletion plus an untracked file.
- `origin/HEAD` is a local copy and can be out of date.
- `--output` overwrites an existing file without asking.
- Non-UTF-8 file names may show replacement characters. Submodules get no special handling.
- In a shallow clone there may be no merge base (the error suggests how to fetch more history).
- No JSON output.
- The 120-second MCP timeout is not covered by a full-length test (the timeout logic is tested with short timeouts).
- The `lint` check fails if the project has no `lint` script.

## Product decision

**Hybrid, MCP-primary.** I assume the main user is an AI coding agent running locally on a developer's machine. MCP is primary because its strict schema makes the tool easy for an agent to discover and limits what it can ask for. The CLI stays for humans, CI and reproducing agent results. I would change this decision if most use turned out to be human or CI (CLI-first), if agents needed structured output (add JSON), or if the server became hosted for many users (real sandbox needed).

## Project layout

```text
src/core.ts         shared review orchestration
src/cli.ts          command-line adapter
src/mcp-server.ts   MCP server entry point (stdio)
src/mcp-tools.ts    MCP tool definition and handler
src/git.ts          Git inspection
src/validation.ts   running checks safely
src/report.ts       Markdown report
src/types.ts        shared types
test/               tests for CLI, Git, MCP, validation and report
```