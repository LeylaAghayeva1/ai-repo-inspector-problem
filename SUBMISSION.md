# Submission

## What did you investigate first, and why?

First I asked Claude to explain the starter in simple words, with an example of how each part fails. Then I traced one request from start to end: input (CLI or MCP) → Git → running checks → report. I looked there first because that is where an outside input can turn into a command on the machine, and I thought safety was the biggest risk. I also read `package.json` and the CI file. They looked small, but they decide whether the tool works outside the source folder.

The main problems I found:
- Validation commands ran through a shell, so any text could become a command.
- The child process got the whole environment, including API keys.
- No timeout and no output limit.
- The base ref was passed straight into Git, and a repository's own Git config could run commands.
- Only committed changes were checked, with a hard-coded branch name.
- The MCP tool and its handler used different field names (`repo_path` / `repoPath`) and accepted any command.
- `--repo` broke on paths with spaces, the `bin` path pointed to a file that does not exist, and CI ran the tests twice.

## What did you choose to implement or fix?

I fixed about 18 of the problems I listed, in this order (safety first):

1. **Validation:** no shell (`spawn` with `shell: false`), cleaned environment, timeout that also kills child processes, output cap, and clear statuses (`passed`, `failed`, `timed_out`, `rejected`).
2. **MCP:** one fixed field name (`repo_path`), strict schema (unknown fields are rejected), named checks only, optional allowed folders, short error messages without server paths.
3. **Git:** the base ref is checked and turned into a commit hash, `core.fsmonitor` is turned off on every call, committed + staged + unstaged + untracked changes are included, renames and odd file names work, the default branch is detected.
4. **CLI:** strict option parsing, exit codes 0/1/2/3, `--output -`, works from the installed `bin`, control characters are cleaned from terminal output.
5. **Report:** Markdown escaping, safe code fences for command output, 200-file limit, output marked as untrusted.
6. **Repo:** fixed the `bin` path, stopped CI from running tests twice.
7. **Tests:** from the starter's tests to 216 tests. They use real temporary Git repositories and a real MCP client and server. Some use a fake `git` to test timeouts and errors.

## What did you intentionally not do?

- **No sandbox.** npm scripts still run real code with the user's permissions. I say this clearly in the README. A real sandbox needs containers, which was outside the time limit.
- No JSON output, no special handling for submodules or non-UTF-8 file names, no per-project check configuration.
- No Windows work. I did not want to claim something I could not test.
- No full-length (120 s) timeout test for MCP. The timeout logic is tested with short timeouts.

## Interface decision

- Decision: **hybrid, MCP-primary**
- Primary user and execution environment: An AI coding agent on a developer's own machine, talking to the tool over stdio MCP. Humans use the CLI to reproduce what the agent saw and in CI.
- Trust boundary and allowed capabilities: The MCP caller and the repository content are untrusted (prompt injection is possible). The agent can only choose from fixed named checks (`test`, `typecheck`, `build`, `lint`) and cannot write command text. The CLI is for a human, so it allows free commands, still without a shell and with a timeout, an output cap and a cleaned environment. Neither is a sandbox, because project scripts can run any code.
- Reliability, discoverability, latency/context, and output tradeoffs: The strict MCP schema makes the tool easy to discover and gives clear errors. MCP output is capped at 16 KiB per check to save the model's context. CLI output is capped at 64 KiB because a person needs more detail. Every command has a timeout, and the report has a file limit.
- How supported interfaces remain consistent: Both call the same core, Git code and report builder. A test runs both on the same repository and compares the reports (ignoring durations). The differences are on purpose: free commands vs named checks, output cap, naming style, and how failures are signalled.
- Evidence that would change this decision: If real usage is mostly humans or CI, I would go CLI-first. If agents need structured results, I would add JSON to both. If the server becomes hosted for many users, I would need container isolation.

## How did you use an AI coding agent?

I used Claude to explain the problem, to write the code and tests, and to give me a short report after every change. I worked in small rounds:

1. I asked Claude to list everything that fails. I picked a smaller set myself, with safety first, and asked Claude to be critical of my choices.
2. For each round I chose one specific problem. Claude wrote the code.
3. Claude gave me a short report: what changed, why, how it was checked, what is not done.
4. I gave that report to two other AI agents for review. I pasted their answers back to Claude, and Claude had to check each claim by reproducing it before changing anything.
5. I replaced the files in my repo, committed, and ran the tests myself.

I treated every suggestion as a guess until it was reproduced. Claude also ran "break it on purpose" checks (for example, removing a protection to see whether a test fails) to show that the tests can actually fail.

## Where did you check, correct, or reject an AI suggestion? (required)

- **Rejected:** my first idea for command safety was a list of dangerous words. That is easy to get around, so we changed to a stronger rule: never use a shell, split the command ourselves and run it with `shell: false`.
- **Rejected:** a reviewer suggested ignoring the user's global Git config. Claude reproduced a problem with that: Git's `safe.directory` setting is often in the global config (Docker, CI), and without it Git refuses to work. We kept the global config and only turned off the dangerous repository setting (`core.fsmonitor`).
- **Rejected:** a reviewer repeated that the base-ref regex had an "escaped asterisk" bug. The code did not contain that pattern, so I did not change anything.
- **Corrected:** a reviewer said unknown MCP fields were silently dropped. Claude reproduced it, and the schema is now strict, with a test.
- **Corrected:** Claude's first Markdown fix put file paths inside code spans, which broke a starter test (`src/index.ts (modified)`). It was changed to backslash escaping.
- **Corrected:** two of our own tests passed even after the protection was removed (path hiding and rename detection). I had Claude rewrite them so they fail when the protection is removed.
- **Corrected:** `--validate -h` was treated as a help request, and terminal control characters got into the output. Both were reproduced and fixed.
- **Corrected:** a final review said the MCP tool hints (`destructiveHint: false`, `openWorldHint: false`) were wrong, because a named npm script can change files and use the network. The MCP spec says both hints default to true. I changed them to `true` and added a test that fails if they are set back to `false`.

## Commands used to verify the result, with outcomes

```bash
npm ci
npm run typecheck     # no errors
npm run build         # no errors
npm test              # 216 passed (5 test files)
```

- **macOS (my machine), Node 24.18.0, Git 2.54.0:** `npm ci`, typecheck, build and tests: all passed, 216 of 216.
- **Linux (Claude's cloud workspace), Node 22.23.4, Git 2.43.0:** clean `npm ci`, typecheck, build, then the test suite 3 times: 216 of 216 each time.
- By hand on my Mac, with a temporary Git repo and the built CLI: the report lists `a.txt (modified)` and `b.txt (untracked)`; `--bogus` gives an error (exit 2); a missing repo gives an error (exit 3); a fake secret in a changed file does not appear in the report; a repo with `core.fsmonitor` set to a command did not run it (also checked on Linux).
- Checked by Claude on Linux with the built CLI: `--validate "echo hi; echo bye"` is `REJECTED`; `node --version` is `PASSED`; `node nofile.js` is `FAILED` (exit 1); a bad base ref gives exit 3.
- Checked by Claude with a real MCP client over stdio: the tool list shows one tool with the new hints; a normal call returns the report; `base_ref: "--output=x"` and an unknown field are both rejected.

## A blocker you hit and how you approached it

Some of my copies of the files were out of date. Two files in my repo did not match what Claude had tested (a line was missing in `core.ts`, and `report.ts` was an old version). Tests failed in ways that did not make sense, because the code and the tests were from different rounds. I did not guess: Claude compared my zip with its tested files and found exactly which files differed. I replaced them and re-ran everything, and after that every upload matched. I now check files by comparing them first, then run the tests.

## Known limitations and the next three things you would do

Limitations:
- No sandbox for project scripts.
- Windows is untested. macOS and Linux were tested.
- An unstaged rename shows as delete + untracked until it is staged.
- `origin/HEAD` can be out of date.
- `--output` overwrites existing files.
- No JSON output, no submodule or non-UTF-8 file name handling.
- The full 120 s MCP timeout is not tested end to end.

Next three things:
1. Test and fix Windows (starting `npm` without a shell, stopping child processes).
2. Add an option to run checks in a container, for repositories I do not trust.
3. Add JSON output, and let a project define its own named checks.

## Approximate focused-work time

- Start: The task email arrived on 12 Nov 2026 at 21:11 (Baku time). I saw it about 45 minutes later and did the first part then.
- Finish: 13 Nov 2026 at 21:00 (Baku time)
- Focused minutes: about 90–95 (my own estimate of focus time only, not timed exactly). I worked in separate parts because of exams and other projects.