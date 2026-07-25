import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { SyncScreen } from "../src/screens/SyncScreen";

vi.mock("../src/utils/flows", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/utils/flows")>();
  return {
    ...actual,
    runSyncLoad: vi.fn(async () => ({
      type: "ok",
      agentDiffs: [],
    })),
  };
});

describe("24-row layouts", () => {
  it("keeps the setup menu description and footer on separate rows", async () => {
    const view = render(<App initialScreen={{ id: "setup" }} />);
    Object.defineProperty(view.stdout, "rows", {
      value: 24,
      configurable: true,
    });
    view.stdout.emit("resize");

    view.stdin.write("\r");

    await vi.waitFor(() => {
      const frame = view.lastFrame();
      expect(frame).toContain("Use any existing remote git repository");
      expect(frame).toContain("↑↓ navigate  Enter select");
      expect(frame).not.toContain("Use any existing ↑↓");
    });
    view.unmount();
  });

  it("keeps the sync confirmation description and footer on separate rows", async () => {
    const view = render(
      <Box height={24}>
        <SyncScreen
          mode="pull"
          signal={new AbortController().signal}
          onBack={() => {}}
        />
      </Box>,
    );

    await vi.waitFor(() => {
      const frame = view.lastFrame();
      expect(frame).toContain("No changes to apply");
      expect(frame).toContain("Esc to cancel");
      expect(frame).not.toContain("No changes tEsc to cancel");
    });
    view.unmount();
  });
});
