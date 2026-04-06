import { describe, it, expect } from "bun:test";
import { isAbsolute } from "path";
import { AGENT_DEFS, BASE_SYNC_FOLDERS, getSyncFolders } from "../src/utils/agentDefs";

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

  it("all custom syncFolders are non-empty arrays", () => {
    for (const def of AGENT_DEFS) {
      if (def.syncFolders) {
        expect(def.syncFolders.length).toBeGreaterThan(0);
        for (const f of def.syncFolders) {
          expect(f.trim()).not.toBe("");
        }
      }
    }
  });
});

describe("BASE_SYNC_FOLDERS", () => {
  it("is a non-empty array", () => {
    expect(BASE_SYNC_FOLDERS.length).toBeGreaterThan(0);
  });

  it("contains common folder names", () => {
    expect(BASE_SYNC_FOLDERS).toContain("skills");
    expect(BASE_SYNC_FOLDERS).toContain("rules");
    expect(BASE_SYNC_FOLDERS).toContain("commands");
  });
});

describe("getSyncFolders", () => {
  it("returns custom syncFolders when defined", () => {
    const def = { id: "test", name: "Test", globalPath: "/test", syncFolders: ["skills"] };
    expect(getSyncFolders(def)).toEqual(["skills"]);
  });

  it("returns BASE_SYNC_FOLDERS when syncFolders is undefined", () => {
    const def = { id: "test", name: "Test", globalPath: "/test" };
    expect(getSyncFolders(def)).toEqual(BASE_SYNC_FOLDERS);
  });
});
