import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The harness set is not fixed once custom harnesses can be declared, so no
// skill text may state how many harnesses or generated files there are.
const SKILL_DIR = new URL("../skills/git-agents/", import.meta.url);
const SKILL_TEXTS = [
  "SKILL.md",
  ...readdirSync(new URL("references/", SKILL_DIR)).map(
    (file) => `references/${file}`,
  ),
];
const COUNT =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:[\w-]+\s+){0,2}?(?:harnesses|files)\b/gi;

describe("skill texts", () => {
  it.each(SKILL_TEXTS)("%s never counts harnesses or generated files", (file) => {
    const text = readFileSync(new URL(file, SKILL_DIR), "utf8");

    expect(text.match(COUNT) ?? []).toEqual([]);
  });

  it("include the harness flow reference", () => {
    expect(SKILL_TEXTS).toContain("references/harness-flow.md");
  });
});
