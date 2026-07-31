import { readFileSync } from "node:fs";
import {
  defaultInternalDeps,
  runInternalCommand,
  type InternalError,
  type InternalOutcome,
} from "./commands";

type ParsedArgs = { command: string; input: unknown } | { error: InternalError };

// Injectable readers so the file and stdin channels are testable; both
// exist so large payloads never have to survive shell quoting.
type InputIo = {
  readFile: (path: string) => string;
  readStdin: () => Promise<string>;
};

const defaultInputIo: InputIo = {
  readFile: (path) => readFileSync(path, "utf8"),
  readStdin: async () => {
    process.stdin.setEncoding("utf8");
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data;
  },
};

function inputError(message: string): ParsedArgs {
  return { error: { code: "invalid-input", message } };
}

export async function parseInternalArgs(
  args: string[],
  io: Partial<InputIo> = {},
): Promise<ParsedArgs> {
  const { readFile, readStdin } = { ...defaultInputIo, ...io };
  const [command, ...rest] = args;
  if (!command) {
    return {
      error: {
        code: "missing-command",
        message:
          "Usage: git-agents --internal <command> [--input <json> | --input - | --input-file <path>]",
      },
    };
  }

  const inputIndex = rest.indexOf("--input");
  const fileIndex = rest.indexOf("--input-file");
  if (inputIndex !== -1 && fileIndex !== -1) {
    return inputError("Pass either --input or --input-file, not both");
  }

  let raw: string;
  let channel: string;
  if (fileIndex !== -1) {
    channel = "the --input-file payload";
    const path = rest[fileIndex + 1];
    if (path === undefined) {
      return inputError("--input-file requires a path argument");
    }
    try {
      raw = readFile(path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return inputError(`Could not read --input-file ${path}: ${reason}`);
    }
  } else if (inputIndex !== -1) {
    const value = rest[inputIndex + 1];
    if (value === undefined) {
      return inputError("--input requires a JSON argument");
    }
    if (value === "-") {
      channel = "the stdin payload";
      try {
        raw = await readStdin();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return inputError(`Could not read stdin: ${reason}`);
      }
    } else {
      channel = "--input";
      raw = value;
    }
  } else {
    return { command, input: undefined };
  }

  try {
    return { command, input: JSON.parse(raw) };
  } catch {
    return inputError(`${channel} is not valid JSON`);
  }
}

export async function runInternalCli(
  args: string[],
  write: (line: string) => void = (line) => process.stdout.write(line),
): Promise<number> {
  let outcome: InternalOutcome;
  try {
    const parsed = await parseInternalArgs(args);
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
