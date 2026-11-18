import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CANONICAL_HARNESSES } from "../src/canonical/canonical";
import { AGENT_DEFS } from "../src/utils/agentDefs";
import {
  HARNESS_DECLARATIONS_FILE,
  parseHarnessDeclarations,
  readHarnessDeclarations,
  validateHarnessDeclarations,
  type DeclarationProblem,
} from "../src/utils/harnessDeclarations";

function problemsOf(content: unknown): DeclarationProblem[] {
  const result = validateHarnessDeclarations(content);
  return result.ok ? [] : result.problems;
}

// A declaration that breaks no rule, so a test can isolate the one it adds.
const VALID = { syncPaths: [".dsh/skills"] };

describe("validateHarnessDeclarations", () => {
  it("yields no custom harnesses and no problems for an empty harnesses object", () => {
    expect(validateHarnessDeclarations({ version: 1, harnesses: {} })).toEqual({
      ok: true,
      harnesses: [],
    });
  });

  it("yields the declared harnesses sorted by id, with name defaulted to the id", () => {
    const result = validateHarnessDeclarations({
      version: 1,
      harnesses: {
        zed: { syncPaths: [".zed/prompts", ".zed/rules"] },
        dsh: {
          name: "DeepSeek Harness",
          instructionsFile: ".dsh/AGENTS.md",
          syncPaths: [".dsh/skills"],
        },
        goose: { instructionsFile: ".config/goose/.goosehints" },
      },
    });

    expect(result).toEqual({
      ok: true,
      harnesses: [
        {
          id: "dsh",
          name: "DeepSeek Harness",
          instructionsFile: ".dsh/AGENTS.md",
          syncPaths: [".dsh/skills"],
        },
        {
          id: "goose",
          name: "goose",
          instructionsFile: ".config/goose/.goosehints",
          syncPaths: [],
        },
        {
          id: "zed",
          name: "zed",
          syncPaths: [".zed/prompts", ".zed/rules"],
        },
      ],
    });
  });

  describe("file shape", () => {
    it("reports an unsupported version and judges nothing else by this version's rules", () => {
      expect(
        problemsOf({ version: 2, harnesses: { dsh: { futureField: true } } }),
      ).toEqual([
        expect.objectContaining({ code: "unsupported-version", field: "version" }),
      ]);
    });

    it("reports a missing version", () => {
      expect(problemsOf({ harnesses: { dsh: VALID } })).toEqual([
        expect.objectContaining({ code: "unsupported-version", field: "version" }),
      ]);
    });

    it("reports an unknown top-level field", () => {
      expect(problemsOf({ version: 1, harnesses: {}, extra: true })).toEqual([
        expect.objectContaining({ code: "unknown-field", field: "extra" }),
      ]);
    });

    it("reports an unknown field in a declaration, naming the harness", () => {
      expect(
        problemsOf({
          version: 1,
          harnesses: { dsh: { ...VALID, paths: [".dsh/extra"] } },
        }),
      ).toEqual([
        expect.objectContaining({
          code: "unknown-field",
          harness: "dsh",
          field: "paths",
        }),
      ]);
    });

    it("reports a declaration with neither instructionsFile nor syncPaths", () => {
      expect(
        problemsOf({
          version: 1,
          harnesses: { dsh: { name: "DeepSeek Harness" }, zed: { syncPaths: [] } },
        }),
      ).toEqual([
        expect.objectContaining({ code: "no-paths", harness: "dsh" }),
        expect.objectContaining({ code: "no-paths", harness: "zed" }),
      ]);
    });

    it.each([
      ["a non-object file", [], undefined, undefined],
      ["a missing harnesses object", { version: 1 }, undefined, "harnesses"],
      ["a non-object harnesses", { version: 1, harnesses: [] }, undefined, "harnesses"],
      ["a non-object declaration", { version: 1, harnesses: { dsh: "x" } }, "dsh", undefined],
      ["a non-string name", { version: 1, harnesses: { dsh: { ...VALID, name: 3 } } }, "dsh", "name"],
      ["an empty name", { version: 1, harnesses: { dsh: { ...VALID, name: "" } } }, "dsh", "name"],
      [
        "a non-string instructionsFile",
        { version: 1, harnesses: { dsh: { instructionsFile: [".dsh/AGENTS.md"] } } },
        "dsh",
        "instructionsFile",
      ],
      [
        "a non-array syncPaths",
        { version: 1, harnesses: { dsh: { syncPaths: ".dsh/skills" } } },
        "dsh",
        "syncPaths",
      ],
      [
        "a non-string syncPaths entry",
        { version: 1, harnesses: { dsh: { syncPaths: [".dsh/skills", 7] } } },
        "dsh",
        "syncPaths",
      ],
    ])("reports %s as an invalid shape", (_label, content, harness, field) => {
      const problems = problemsOf(content);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ code: "invalid-shape" });
      expect(problems[0]?.harness).toBe(harness);
      expect(problems[0]?.field).toBe(field);
    });
  });

  describe("ids", () => {
    function idProblems(id: string): DeclarationProblem[] {
      return problemsOf({ version: 1, harnesses: { [id]: VALID } });
    }

    it.each(["a", "dsh", "kilo-code", "x9", `a${"b".repeat(31)}`])(
      "accepts %s",
      (id) => {
        expect(idProblems(id)).toEqual([]);
      },
    );

    it.each([
      ["an uppercase letter", "Dsh"],
      ["a leading digit", "9lives"],
      ["a leading hyphen", "-dsh"],
      ["an underscore", "my_harness"],
      ["a dot", "dsh.v2"],
      ["a space", "my harness"],
      ["33 characters", `a${"b".repeat(32)}`],
      ["an empty id", ""],
    ])("rejects %s", (_label, id) => {
      expect(idProblems(id)).toEqual([
        expect.objectContaining({ code: "invalid-id", harness: id }),
      ]);
    });

    it.each(["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"])(
      "rejects the Windows device name %s",
      (id) => {
        expect(idProblems(id)).toEqual([
          expect.objectContaining({ code: "invalid-id", harness: id }),
        ]);
      },
    );

    it.each([
      "claude-code",
      "claude",
      "codex",
      "cursor",
      "gemini-cli",
      "gemini",
      "opencode",
    ])("rejects the built-in id %s", (id) => {
      expect(idProblems(id)).toEqual([
        expect.objectContaining({ code: "reserved-id", harness: id }),
      ]);
    });

    it("reserves every id the built-ins use for transport and for overlays", () => {
      for (const id of [...AGENT_DEFS.map((def) => def.id), ...CANONICAL_HARNESSES]) {
        expect(idProblems(id)).toEqual([
          expect.objectContaining({ code: "reserved-id", harness: id }),
        ]);
      }
    });
  });

  describe.each(["instructionsFile", "syncPaths"] as const)(
    "path rules for %s",
    (field) => {
      function pathProblems(path: string): DeclarationProblem[] {
        const declaration =
          field === "instructionsFile"
            ? { instructionsFile: path }
            : { syncPaths: [path] };
        return problemsOf({ version: 1, harnesses: { dsh: declaration } });
      }

      it.each([
        ".dsh/AGENTS.md",
        ".config/goose/.goosehints",
        "Library/Application Support/dsh/rules",
        ".dsh/notes.v2.final",
        ".github-copilot/instructions",
        ".sshx/notes",
        ".config/ghostty/config",
        "canonical-notes/core.md",
      ])("accepts %s", (path) => {
        expect(pathProblems(path)).toEqual([]);
      });

      it.each([
        ["an empty path", ""],
        ["a parent segment", ".dsh/../.claude/skills"],
        ["a leading parent segment", "../dsh/skills"],
        ["a backslash", ".dsh\\skills"],
        ["an absolute path", "/etc/dsh/skills"],
        ["a drive-letter path", "C:/Users/me/.dsh"],
        ["an empty segment", ".dsh//skills"],
        ["a trailing slash", ".dsh/skills/"],
        ["a leading dot segment", "./.dsh/skills"],
        ["an inner dot segment", ".dsh/./skills"],
        ["a < in a segment", ".dsh/a<b"],
        ["a > in a segment", ".dsh/a>b"],
        ["a : in a segment", ".dsh/a:b"],
        ['a " in a segment', '.dsh/a"b'],
        ["a | in a segment", ".dsh/a|b"],
        ["a ? in a segment", ".dsh/a?b"],
        ["a * in a segment", ".dsh/*"],
        ["a control character in a segment", ".dsh/a\u0001b"],
        ["a segment ending in a dot", ".dsh/skills."],
        ["a segment ending in a space", ".dsh /skills"],
        ["a device name segment", ".dsh/nul"],
        ["a device name segment in another case", ".dsh/CON/skills"],
        ["a device name with an extension", ".dsh/aux.md"],
      ])("rejects %s as not portable", (_label, path) => {
        expect(pathProblems(path)).toEqual([
          expect.objectContaining({
            code: "path-not-portable",
            harness: "dsh",
            field,
            path,
          }),
        ]);
      });

      it.each([".dsh", ".bashrc", "AGENTS.md"])(
        "rejects %s, which sits at the home root",
        (path) => {
          expect(pathProblems(path)).toEqual([
            expect.objectContaining({
              code: "path-at-home-root",
              harness: "dsh",
              field,
              path,
            }),
          ]);
        },
      );

      it.each([
        ".git/hooks",
        ".git-agents/config.json",
        "canonical/core.md",
        ".GIT/hooks",
        "Canonical/overlays/dsh.md",
      ])("rejects %s for its reserved first segment", (path) => {
        expect(pathProblems(path)).toEqual([
          expect.objectContaining({
            code: "path-reserved",
            harness: "dsh",
            field,
            path,
          }),
        ]);
      });

      it.each([
        ".ssh/config",
        ".gnupg/gpg.conf",
        ".aws/credentials",
        ".azure/config",
        ".kube/config",
        ".docker/config.json",
        ".config/gh",
        ".config/gh/hosts.yml",
        ".config/gcloud",
        ".config/gcloud/configurations/config_default",
        ".config/git",
        ".config/git/config",
        ".SSH/id_ed25519",
        ".Config/GH/hosts.yml",
      ])("rejects %s as a credential location", (path) => {
        expect(pathProblems(path)).toEqual([
          expect.objectContaining({
            code: "path-denylisted",
            harness: "dsh",
            field,
            path,
          }),
        ]);
      });

      it.each([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"])(
        "rejects the credential directory %s itself",
        (path) => {
          expect(pathProblems(path)).toContainEqual(
            expect.objectContaining({
              code: "path-denylisted",
              harness: "dsh",
              field,
              path,
            }),
          );
        },
      );
    },
  );

  describe("one owner per path", () => {
    function harnessProblems(
      harnesses: Record<string, unknown>,
    ): DeclarationProblem[] {
      return problemsOf({ version: 1, harnesses });
    }

    it.each([
      ["equal to a built-in's path", ".claude/skills", ".claude/skills", "claude-code"],
      ["equal to a built-in's path in another case", ".Claude/Skills", ".claude/skills", "claude-code"],
      ["inside a built-in's path", ".agents/skills/dsh", ".agents/skills", "codex"],
      ["inside a built-in's path in another case", ".GEMINI/Commands/dsh", ".gemini/commands", "gemini-cli"],
    ])("rejects a sync path %s", (_label, path, builtInPath, builtInId) => {
      const problems = harnessProblems({ dsh: { syncPaths: [path] } });
      expect(problems).toEqual([
        expect.objectContaining({
          code: "path-overlap",
          harness: "dsh",
          field: "syncPaths",
          path,
        }),
      ]);
      expect(problems[0]?.message).toContain(`"${builtInPath}"`);
      expect(problems[0]?.message).toContain(`"${builtInId}"`);
    });

    it("rejects a path that contains several built-in paths, once", () => {
      const problems = harnessProblems({
        dsh: { syncPaths: [".config/opencode"] },
      });
      expect(problems).toEqual([
        expect.objectContaining({
          code: "path-overlap",
          harness: "dsh",
          field: "syncPaths",
          path: ".config/opencode",
        }),
      ]);
      expect(problems[0]?.message).toContain('".config/opencode/AGENTS.md"');
      expect(problems[0]?.message).toContain('".config/opencode/skills"');
    });

    it("rejects an instructionsFile a built-in already generates", () => {
      expect(
        harnessProblems({
          kilo: { instructionsFile: ".claude/CLAUDE.md", syncPaths: [".kilocode/rules"] },
        }),
      ).toEqual([
        expect.objectContaining({
          code: "path-overlap",
          harness: "kilo",
          field: "instructionsFile",
          path: ".claude/CLAUDE.md",
        }),
      ]);
    });

    it.each([
      [".claude/output-styles"],
      [".claude/skills-extra"],
      [".agents/AGENTS.md"],
      [".config/opencode-extra/skills"],
    ])("accepts %s, a sibling of built-in paths", (path) => {
      expect(harnessProblems({ dsh: { syncPaths: [path] } })).toEqual([]);
    });

    it("rejects the same path declared by two harnesses, regardless of case", () => {
      const problems = harnessProblems({
        zed: { instructionsFile: ".Agents/agents.md" },
        dsh: { instructionsFile: ".agents/AGENTS.md" },
      });
      expect(problems).toEqual([
        expect.objectContaining({
          code: "path-overlap",
          harness: "zed",
          field: "instructionsFile",
          path: ".Agents/agents.md",
        }),
      ]);
      expect(problems[0]?.message).toContain('".agents/AGENTS.md"');
      expect(problems[0]?.message).toContain('"dsh"');
    });

    it("rejects a path nested inside another harness's path, in either direction", () => {
      expect(
        harnessProblems({
          dsh: { syncPaths: [".shared/tools"] },
          zed: { syncPaths: [".shared/tools/zed"] },
        }),
      ).toEqual([
        expect.objectContaining({
          code: "path-overlap",
          harness: "zed",
          path: ".shared/tools/zed",
        }),
      ]);
      expect(
        harnessProblems({
          dsh: { syncPaths: [".shared/tools/dsh"] },
          zed: { syncPaths: [".shared/tools"] },
        }),
      ).toEqual([
        expect.objectContaining({
          code: "path-overlap",
          harness: "zed",
          path: ".shared/tools",
        }),
      ]);
    });

    it("rejects a duplicate and a nested entry within one harness's syncPaths", () => {
      expect(
        harnessProblems({
          dsh: { syncPaths: [".dsh/skills", ".dsh/Skills", ".dsh/skills/core"] },
        }),
      ).toEqual([
        expect.objectContaining({
          code: "path-overlap",
          harness: "dsh",
          field: "syncPaths",
          path: ".dsh/Skills",
        }),
        expect.objectContaining({
          code: "path-overlap",
          harness: "dsh",
          field: "syncPaths",
          path: ".dsh/skills/core",
        }),
      ]);
    });

    it("rejects an instructionsFile repeated in, or inside, its own syncPaths", () => {
      expect(
        harnessProblems({
          dsh: { instructionsFile: ".dsh/AGENTS.md", syncPaths: [".dsh/AGENTS.md"] },
        }),
      ).toEqual([
        expect.objectContaining({ code: "path-overlap", harness: "dsh" }),
      ]);
      expect(
        harnessProblems({
          dsh: { instructionsFile: ".dsh/rules/AGENTS.md", syncPaths: [".dsh/rules"] },
        }),
      ).toEqual([
        expect.objectContaining({ code: "path-overlap", harness: "dsh" }),
      ]);
    });

    it("judges ids and paths against the built-in definitions it is given", () => {
      const builtIns = [{ id: "acme", name: "Acme", syncPaths: [".acme/skills"] }];
      const validate = (harnesses: Record<string, unknown>) =>
        validateHarnessDeclarations({ version: 1, harnesses }, builtIns);

      expect(validate({ dsh: { syncPaths: [".claude/skills"] } })).toMatchObject({
        ok: true,
      });
      expect(validate({ acme: VALID })).toMatchObject({
        ok: false,
        problems: [{ code: "reserved-id", harness: "acme" }],
      });
      expect(validate({ dsh: { syncPaths: [".acme/skills/dsh"] } })).toMatchObject({
        ok: false,
        problems: [{ code: "path-overlap", harness: "dsh", path: ".acme/skills/dsh" }],
      });
    });
  });

  it("reports every problem in a file, not just the first", () => {
    const problems = problemsOf({
      harnesses: {
        Bad_Id: { instructionsFile: ".bad/AGENTS.md" },
        claude: { syncPaths: [".claude2/skills"] },
        dsh: {
          instructionsFile: ".ssh/AGENTS.md",
          syncPaths: [".dsh\\skills", ".dsh", ".claude/skills/dsh"],
          color: "blue",
        },
        empty: {},
      },
      comment: "hand-edited",
    });

    expect(
      problems.map(({ code, harness, field, path }) => ({ code, harness, field, path })),
    ).toEqual([
      { code: "unsupported-version", harness: undefined, field: "version", path: undefined },
      { code: "unknown-field", harness: undefined, field: "comment", path: undefined },
      { code: "invalid-id", harness: "Bad_Id", field: undefined, path: undefined },
      { code: "reserved-id", harness: "claude", field: undefined, path: undefined },
      { code: "unknown-field", harness: "dsh", field: "color", path: undefined },
      { code: "path-denylisted", harness: "dsh", field: "instructionsFile", path: ".ssh/AGENTS.md" },
      { code: "path-not-portable", harness: "dsh", field: "syncPaths", path: ".dsh\\skills" },
      { code: "path-at-home-root", harness: "dsh", field: "syncPaths", path: ".dsh" },
      { code: "path-overlap", harness: "dsh", field: "syncPaths", path: ".claude/skills/dsh" },
      { code: "no-paths", harness: "empty", field: undefined, path: undefined },
    ]);
    for (const problem of problems) {
      expect(problem.message).not.toBe("");
    }
  });
});

const DSH_FILE = {
  version: 1,
  harnesses: {
    dsh: { instructionsFile: ".dsh/AGENTS.md", syncPaths: [".dsh/skills"] },
  },
};
const DSH_HARNESSES = [
  {
    id: "dsh",
    name: "dsh",
    instructionsFile: ".dsh/AGENTS.md",
    syncPaths: [".dsh/skills"],
  },
];

describe("parseHarnessDeclarations", () => {
  it("validates the text of a declarations file", () => {
    expect(parseHarnessDeclarations(JSON.stringify(DSH_FILE, null, 2))).toEqual({
      ok: true,
      harnesses: DSH_HARNESSES,
    });
    expect(
      parseHarnessDeclarations('{"version":1,"harnesses":{"codex":{"syncPaths":[".x/y"]}}}'),
    ).toMatchObject({
      ok: false,
      problems: [{ code: "reserved-id", harness: "codex" }],
    });
  });

  it("accepts a file saved with a byte-order mark", () => {
    expect(parseHarnessDeclarations(`\uFEFF${JSON.stringify(DSH_FILE)}`)).toEqual({
      ok: true,
      harnesses: DSH_HARNESSES,
    });
  });

  it.each([
    ["truncated JSON", '{"version": 1, "harnesses": {'],
    ["a trailing comma", '{"version": 1, "harnesses": {},}'],
    ["a merge conflict left in the file", '<<<<<<< HEAD\n{"version":1,"harnesses":{}}\n=======\n'],
    ["an empty file", ""],
  ])("reports %s as malformed JSON, never as nothing declared", (_label, text) => {
    expect(parseHarnessDeclarations(text)).toEqual({
      ok: false,
      problems: [expect.objectContaining({ code: "malformed-json" })],
    });
  });
});

describe("readHarnessDeclarations", () => {
  const tmpDirs: string[] = [];

  function makeRepo(): string {
    const dir = join(
      tmpdir(),
      `ga-harnesses-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("yields no custom harnesses and no problems when the file is absent", () => {
    expect(readHarnessDeclarations(makeRepo())).toEqual({
      ok: true,
      harnesses: [],
    });
  });

  it("yields no custom harnesses and no problems for an empty harnesses object", () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, HARNESS_DECLARATIONS_FILE),
      '{ "version": 1, "harnesses": {} }\n',
    );

    expect(readHarnessDeclarations(repo)).toEqual({ ok: true, harnesses: [] });
  });

  it("reads the declarations from .git-agents-harnesses.json at the repo root", () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, ".git-agents-harnesses.json"),
      `${JSON.stringify(DSH_FILE, null, 2)}\n`,
    );

    expect(readHarnessDeclarations(repo)).toEqual({
      ok: true,
      harnesses: DSH_HARNESSES,
    });
  });

  it("reports the problems of an invalid file", () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, HARNESS_DECLARATIONS_FILE),
      JSON.stringify({ version: 1, harnesses: { dsh: { syncPaths: [".ssh/keys"] } } }),
    );

    expect(readHarnessDeclarations(repo)).toMatchObject({
      ok: false,
      problems: [{ code: "path-denylisted", harness: "dsh", path: ".ssh/keys" }],
    });
  });

  it("reports malformed JSON", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, HARNESS_DECLARATIONS_FILE), "{ not json");

    expect(readHarnessDeclarations(repo)).toMatchObject({
      ok: false,
      problems: [{ code: "malformed-json" }],
    });
  });

  it("reports a declarations path that is not a regular file", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, HARNESS_DECLARATIONS_FILE));

    expect(readHarnessDeclarations(repo)).toMatchObject({
      ok: false,
      problems: [{ code: "unreadable" }],
    });
  });

  it("judges the file against the built-in definitions it is given", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, HARNESS_DECLARATIONS_FILE), JSON.stringify(DSH_FILE));

    expect(
      readHarnessDeclarations(repo, [
        { id: "acme", name: "Acme", syncPaths: [".dsh/skills"] },
      ]),
    ).toMatchObject({
      ok: false,
      problems: [{ code: "path-overlap", harness: "dsh", path: ".dsh/skills" }],
    });
  });
});
