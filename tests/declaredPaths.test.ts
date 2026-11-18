import { describe, expect, it } from "vitest";
import { declaredPaths, pathsOnlyIn, uniquePaths } from "../src/utils/declaredPaths";
import { BUILT_IN_HARNESSES, buildHarnessSet } from "../src/utils/harnessSet";

const DSH = {
  id: "dsh",
  name: "DeepSeek Harness",
  instructionsFile: ".dsh/AGENTS.md",
  syncPaths: [".dsh/skills"],
};
const GOOSE = { id: "goose", name: "goose", syncPaths: [".config/goose/recipes"] };

describe("declared paths", () => {
  it("lists every transported path with the harness and the field that declare it", () => {
    const custom = declaredPaths(buildHarnessSet([DSH])).filter(
      ({ harness }) => harness === "dsh",
    );

    expect(custom).toEqual([
      { harness: "dsh", name: "DeepSeek Harness", field: "instructionsFile", path: ".dsh/AGENTS.md" },
      { harness: "dsh", name: "DeepSeek Harness", field: "syncPaths", path: ".dsh/skills" },
    ]);
  });

  it("finds the paths one set declares and another does not, in both directions", () => {
    const base = buildHarnessSet([DSH]);
    const remote = buildHarnessSet([
      { ...DSH, syncPaths: [".dsh/skills", ".dsh/commands"] },
      GOOSE,
    ]);

    // Newly declared by the remote.
    expect(pathsOnlyIn(remote, base)).toEqual([
      { harness: "dsh", name: "DeepSeek Harness", field: "syncPaths", path: ".dsh/commands" },
      { harness: "goose", name: "goose", field: "syncPaths", path: ".config/goose/recipes" },
    ]);
    // Removed by the remote.
    expect(pathsOnlyIn(base, BUILT_IN_HARNESSES)).toEqual([
      { harness: "dsh", name: "DeepSeek Harness", field: "instructionsFile", path: ".dsh/AGENTS.md" },
      { harness: "dsh", name: "DeepSeek Harness", field: "syncPaths", path: ".dsh/skills" },
    ]);
    expect(pathsOnlyIn(base, remote)).toEqual([]);
  });

  it("treats paths that differ only by case as the same path", () => {
    const base = buildHarnessSet([DSH]);
    const recased = buildHarnessSet([{ ...DSH, syncPaths: [".dsh/Skills"] }]);

    expect(pathsOnlyIn(recased, base)).toEqual([]);
    expect(
      uniquePaths([{ path: ".dsh/skills" }, { path: ".DSH/skills" }, { path: ".dsh/commands" }]),
    ).toEqual([{ path: ".dsh/skills" }, { path: ".dsh/commands" }]);
  });
});
