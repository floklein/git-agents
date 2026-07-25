import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { SelectMenu } from "../src/components/SelectMenu";

const OPTIONS = [
  { name: "First", description: "First option", value: "first" },
  { name: "Second", description: "Second option", value: "second" },
  { name: "Third", description: "Third option", value: "third" },
] as const;

describe("SelectMenu", () => {
  it("highlights the first option by default and shows descriptions", () => {
    const view = render(<SelectMenu options={OPTIONS} onSelect={() => {}} />);

    expect(view.lastFrame()).toContain("❯ First");
    expect(view.lastFrame()).toContain("First option");

    view.unmount();
  });

  it("moves with arrow keys and selects with Enter", async () => {
    const onSelect = vi.fn();
    const view = render(
      <SelectMenu options={OPTIONS} onSelect={onSelect} />,
    );

    view.stdin.write("\u001B[B");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("❯ Second");
    });
    view.stdin.write("\r");

    await vi.waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(OPTIONS[1]);
    });
    view.unmount();
  });

  it("selects the updated option when navigation and Enter are buffered", async () => {
    const onSelect = vi.fn();
    const view = render(
      <SelectMenu options={OPTIONS} onSelect={onSelect} />,
    );

    view.stdin.write("\u001B[B\r");

    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("❯ Second");
      expect(onSelect).toHaveBeenCalledWith(OPTIONS[1]);
    });
    view.unmount();
  });

  it("supports j and k navigation", async () => {
    const onSelect = vi.fn();
    const view = render(
      <SelectMenu
        options={OPTIONS}
        initialIndex={1}
        onSelect={onSelect}
      />,
    );

    view.stdin.write("j");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("❯ Third");
    });
    view.stdin.write("k");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("❯ Second");
    });

    view.unmount();
  });

  it("clamps navigation at the first and last options", async () => {
    const onSelect = vi.fn();
    const view = render(
      <SelectMenu options={OPTIONS} onSelect={onSelect} />,
    );

    view.stdin.write("\u001B[A");
    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(onSelect).toHaveBeenLastCalledWith(OPTIONS[0]);
    });

    view.stdin.write("\u001B[B");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("❯ Second");
    });
    view.stdin.write("\u001B[B");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("❯ Third");
    });
    view.stdin.write("\u001B[B");
    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(onSelect).toHaveBeenLastCalledWith(OPTIONS[2]);
    });

    view.unmount();
  });
});
