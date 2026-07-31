import {
  defaultInternalDeps,
  runInternalCommand,
  type InternalError,
  type InternalOutcome,
} from "./commands";

type ParsedArgs = { command: string; input: unknown } | { error: InternalError };

export function parseInternalArgs(args: string[]): ParsedArgs {
  const [command, ...rest] = args;
  if (!command) {
    return {
      error: {
        code: "missing-command",
        message: "Usage: git-agents --internal <command> [--input <json>]",
      },
    };
  }

  let input: unknown;
  const inputIndex = rest.indexOf("--input");
  if (inputIndex !== -1) {
    const raw = rest[inputIndex + 1];
    if (raw === undefined) {
      return {
        error: { code: "invalid-input", message: "--input requires a JSON argument" },
      };
    }
    try {
      input = JSON.parse(raw);
    } catch {
      return {
        error: { code: "invalid-input", message: "--input is not valid JSON" },
      };
    }
  }

  return { command, input };
}

export async function runInternalCli(
  args: string[],
  write: (line: string) => void = (line) => process.stdout.write(line),
): Promise<number> {
  let outcome: InternalOutcome;
  try {
    const parsed = parseInternalArgs(args);
    outcome =
      "error" in parsed
        ? { ok: false, error: parsed.error }
        : await runInternalCommand(
            parsed.command,
            parsed.input,
            defaultInternalDeps(),
          );
  } catch (error: any) {
    outcome = {
      ok: false,
      error: {
        code: "internal-error",
        message: error?.message ?? String(error),
      },
    };
  }

  write(`${JSON.stringify(outcome)}\n`);
  return outcome.ok ? 0 : 1;
}
