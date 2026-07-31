import type { z } from "zod";

export class InternalCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InternalCommandError";
    this.code = code;
  }
}

export function invalidInputError(
  subject: string,
  error: z.ZodError,
): InternalCommandError {
  const issues = error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  return new InternalCommandError(
    "invalid-input",
    `${subject} input does not match the expected shape: ${issues}`,
  );
}
