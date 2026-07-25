import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { MainMenuScreen } from "../src/screens/MainMenuScreen";

describe("MainMenuScreen", () => {
  it("renders the Ink menu and option descriptions", () => {
    const view = render(<MainMenuScreen onNavigate={() => {}} />);
    const frame = view.lastFrame();

    expect(frame).toContain("Sync portable AI harness files");
    expect(frame).toContain("❯ Pull");
    expect(frame).toContain("Download harness files to this machine");

    view.unmount();
  });

  it("navigates to the selected screen", async () => {
    const onNavigate = vi.fn();
    const view = render(<MainMenuScreen onNavigate={onNavigate} />);

    view.stdin.write("\u001B[B");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("❯ Push");
    });
    view.stdin.write("\r");

    await vi.waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith({ id: "sync", mode: "push" });
    });

    view.unmount();
  });
});
