import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The VERSION file ships with the skill and is the staleness basis for
// the update check; it must move in lockstep with package.json.
describe("skill VERSION file", () => {
  it("matches the package version", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const version = readFileSync(
      new URL("../skills/git-agents/VERSION", import.meta.url),
      "utf8",
    ).trim();

    expect(version).toBe(pkg.version);
  });
});
