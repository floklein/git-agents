import { describe, it, expect } from "bun:test";
import { isAbsolute } from "path";
import { AGENT_DEFS } from "../src/utils/agentDefs";

describe("AGENT_DEFS", () => {
  it("has at least one entry", () => {
    expect(AGENT_DEFS.length).toBeGreaterThan(0);
  });

  it("all entries have non-empty id, name, and globalPath", () => {
    for (const def of AGENT_DEFS) {
      expect(def.id.trim()).not.toBe("");
      expect(def.name.trim()).not.toBe("");
      expect(def.globalPath.trim()).not.toBe("");
    }
  });

  it("has no duplicate ids", () => {
    const ids = AGENT_DEFS.map((d) => d.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("all globalPath values are absolute paths", () => {
    for (const def of AGENT_DEFS) {
      expect(isAbsolute(def.globalPath)).toBe(true);
    }
  });
});
