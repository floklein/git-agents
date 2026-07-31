export class InternalCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InternalCommandError";
    this.code = code;
  }
}
