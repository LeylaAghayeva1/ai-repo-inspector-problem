import { inspectChanges } from "./git.js";
import { markdownReport } from "./report.js";
import type { ReviewRequest } from "./types.js";
import { runValidations } from "./validation.js";

export async function reviewRepository(request: ReviewRequest): Promise<string> {
  // Git inspection runs first: a bad ref or repository must fail before any command is started.
  const { files, base } = inspectChanges(request.repositoryPath, request.baseRef);
  const validations = await runValidations(
    request.validationCommands ?? [],
    request.repositoryPath,
    request.validationOptions,
  );
  return markdownReport({
    repositoryPath: request.repositoryPath,
    changedFiles: files,
    base,
    validationResults: validations,
  });
}