import { spawn } from "node:child_process";
import { errorMessage } from "../utils/errors";

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
export const NUL = String.fromCharCode(0);

export type GitResult = {
  ok: boolean;
  output: string;
  error?: string;
  exitCode?: number;
  oversized?: boolean;
};

// Own runner instead of shell.runCommand: conflict contents must not be
// tail-truncated, and error sniffing needs untranslated git messages.
export function git(dir: string, ...args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", ["-C", dir, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      });
    } catch (error) {
      resolve({
        ok: false,
        output: "",
        error: errorMessage(error),
      });
      return;
    }

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let oversized = false;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_CAPTURE_BYTES) stdout.push(chunk);
      else oversized = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.on("error", (error) => {
      resolve({ ok: false, output: "", error: error.message });
    });
    child.on("close", (exitCode) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errText = Buffer.concat(stderr).toString("utf8").trim();
      resolve({
        ok: exitCode === 0,
        output,
        error:
          exitCode === 0
            ? undefined
            : errText || `git exited with code ${exitCode ?? "unknown (terminated)"}`,
        exitCode: exitCode ?? undefined,
        oversized: oversized || undefined,
      });
    });
  });
}
