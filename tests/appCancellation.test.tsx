import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

const observed = vi.hoisted(() => ({
  signal: undefined as AbortSignal | undefined,
}));

vi.mock("../src/screens/SetupScreen", () => ({
  SetupScreen: ({ signal }: { signal: AbortSignal }) => {
    observed.signal = signal;
    return null;
  },
}));

describe("App cancellation", () => {
  const previousExitCode = process.exitCode;

  afterEach(() => {
    observed.signal = undefined;
    process.exitCode = previousExitCode;
  });

  it("aborts active work before exiting on Ctrl+C", async () => {
    const view = render(<App initialScreen={{ id: "setup" }} />);

    view.stdin.write("\x03");

    await vi.waitFor(() => {
      expect(observed.signal?.aborted).toBe(true);
      expect(process.exitCode).toBe(130);
    });
  });
});
