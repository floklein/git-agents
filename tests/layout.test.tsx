import { Box } from "ink";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { SyncScreen } from "../src/screens/SyncScreen";
import { AGENT_DEFS } from "../src/utils/agentDefs";
import type { AgentDiffEntry } from "../src/utils/flows";

const syncState = vi.hoisted(() => ({
  agentDiffs: [] as AgentDiffEntry[],
}));

vi.mock("../src/utils/flows", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/utils/flows")>();
  return {
    ...actual,
    runSyncLoad: vi.fn(async () => ({
      type: "ok",
      agentDiffs: syncState.agentDiffs,
    })),
  };
});

afterEach(() => {
  syncState.agentDiffs = [];
});

function populatedAgentDiffs(): AgentDiffEntry[] {
  return AGENT_DEFS.map((def) => ({
    def,
    pathDiffs: def.syncPaths.map((path) => ({
      path,
      localBasePath: "C:\\local",
      remoteBasePath: "C:\\remote",
      localPath: `C:\\local\\${path}`,
      remotePath: `C:\\remote\\${path}`,
      status: "added",
      local: {
        kind: "file",
        fileCount: 1,
        contentHash: "local",
      },
      remote: null,
    })),
    remoteCount: 0,
    localCount: def.syncPaths.length,
  }));
}

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

  it("keeps every populated harness path reviewable at 24 rows", async () => {
    syncState.agentDiffs = populatedAgentDiffs();
    const view = render(
      <Box height={24}>
        <SyncScreen
          mode="push"
          signal={new AbortController().signal}
          onBack={() => {}}
        />
      </Box>,
    );

    const reviewedPaths = new Set<string>();
    for (const [index, def] of AGENT_DEFS.entries()) {
      await vi.waitFor(() => {
        const frame = view.lastFrame() ?? "";
        expect(frame.split("\n")).toHaveLength(24);
        expect(frame).toContain(`Harness ${index + 1}/${AGENT_DEFS.length}`);
        expect(frame).toContain(def.name);
        expect(frame).toContain("Confirm push?");
        expect(frame).toContain("Apply changes");
        expect(frame).toContain("←/→ review harnesses");
        for (const path of def.syncPaths) {
          expect(frame).toContain(path);
          reviewedPaths.add(path);
        }
      });

      if (index < AGENT_DEFS.length - 1) {
        view.stdin.write("\u001B[C");
      }
    }

    expect([...reviewedPaths].sort()).toEqual(
      AGENT_DEFS.flatMap((def) => def.syncPaths).sort(),
    );
    view.unmount();
  });
});
