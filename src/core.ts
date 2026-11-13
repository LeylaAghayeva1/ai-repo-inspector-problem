import { inspectChanges } from "./git.js";
import { markdownReport } from "./report.js";
import type { ReviewRequest, ValidationResult } from "./types.js";
import { runValidations } from "./validation.js";

export type ReviewOutcome = { report: string; validations: ValidationResult[] };

/** Full result: the report plus the raw validation results (the CLI uses these for its exit code). */
export async function runReview(request: ReviewRequest): Promise<ReviewOutcome> {
  if (request.format !== undefined && (request.format as string) !== "markdown") {
    throw new Error(`Unsupported format ${JSON.stringify(String(request.format))}: only "markdown" is available.`);
  }
  // Git inspection runs first: a bad ref or repository must fail before any command is started.
  const { files, base } = inspectChanges(request.repositoryPath, request.baseRef);
  const validations = await runValidations(
    request.validationCommands ?? [],
    request.repositoryPath,
    request.validationOptions,
  );
  const report = markdownReport({
    repositoryPath: request.repositoryPath,
    changedFiles: files,
    base,
    validationResults: validations,
  });
  return { report, validations };
}

export async function reviewRepository(request: ReviewRequest): Promise<string> {
  return (await runReview(request)).report;
}