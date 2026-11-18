import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_DEFS,
  BUILT_IN_CONVERGENCE,
  type AgentDef,
} from "./agentDefs";
import { isAtOrInside, pathKey } from "./pathKey";

export const HARNESS_DECLARATIONS_FILE = ".git-agents-harnesses.json";

export type CustomHarness = {
  id: string;
  name: string;
  instructionsFile?: string;
  syncPaths: string[];
};

export type DeclarationProblemCode =
  | "unreadable"
  | "malformed-json"
  | "invalid-shape"
  | "unsupported-version"
  | "unknown-field"
  | "no-paths"
  | "invalid-id"
  | "reserved-id"
  | "path-not-portable"
  | "path-at-home-root"
  | "path-reserved"
  | "path-denylisted"
  | "path-overlap";

export type DeclarationProblem = {
  code: DeclarationProblemCode;
  /** The id of the declaration at fault; absent for a file-level problem. */
  harness?: string;
  /** The offending field, e.g. `version`, `instructionsFile`, `syncPaths`. */
  field?: string;
  /** The offending path, when the problem is about one. */
  path?: string;
  message: string;
};

export type HarnessDeclarationsResult =
  | { ok: true; harnesses: CustomHarness[] }
  | { ok: false; problems: DeclarationProblem[] };

/** The one version of the file this git-agents reads and writes. */
export const DECLARATIONS_VERSION = 1;
const FILE_FIELDS = ["version", "harnesses"];
const DECLARATION_FIELDS = ["name", "instructionsFile", "syncPaths"];

/** What a custom harness id may be. */
export const HARNESS_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
// Each built-in answers to two ids: its transport id, in the built-in
// definitions, and the id it uses for overlays, markers and manifest keys.
const BUILT_IN_OVERLAY_IDS: readonly string[] = BUILT_IN_CONVERGENCE.map(
  ({ overlayId }) => overlayId,
);
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const WINDOWS_FORBIDDEN_CHARACTER = /[<>:"|?*\x00-\x1f]/;

// Compared by `pathKey`, case-insensitively.
const RESERVED_FIRST_SEGMENTS = [".git", ".git-agents", "canonical"];
const CREDENTIAL_DENYLIST = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config/gh",
  ".config/gcloud",
  ".config/git",
];

/** The field of a declaration that holds a path. */
export type HarnessPathField = "instructionsFile" | "syncPaths";

/** A path some harness already owns, for the one-owner rule. */
type OwnedPath = {
  owner: string;
  builtIn: boolean;
  field?: HarnessPathField;
  path: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates parsed declarations content against the shape and the path rules.
 * Pure: it reads nothing from disk, so it serves a file, a proposal and a
 * merge result alike. Every problem is collected; none short-circuits the
 * others, except an unsupported `version`, whose rules this code cannot know.
 */
export function validateHarnessDeclarations(
  content: unknown,
  builtIns: readonly AgentDef[] = AGENT_DEFS,
): HarnessDeclarationsResult {
  const problems: DeclarationProblem[] = [];
  const harnesses: CustomHarness[] = [];
  const owned: OwnedPath[] = builtIns.flatMap((builtIn) =>
    builtIn.syncPaths.map((path) => ({ owner: builtIn.id, builtIn: true, path })),
  );

  if (!isPlainObject(content)) {
    return invalid([
      {
        code: "invalid-shape",
        message: `${HARNESS_DECLARATIONS_FILE} must be a JSON object with "version" and "harnesses"`,
      },
    ]);
  }

  if (content.version === undefined) {
    problems.push({
      code: "unsupported-version",
      field: "version",
      message: `"version" is missing; it must be ${DECLARATIONS_VERSION}`,
    });
  } else if (content.version !== DECLARATIONS_VERSION) {
    return invalid([
      {
        code: "unsupported-version",
        field: "version",
        message: `"version" ${JSON.stringify(content.version)} is not supported; this git-agents understands only version ${DECLARATIONS_VERSION}, so update git-agents or set it to ${DECLARATIONS_VERSION}`,
      },
    ]);
  }

  for (const field of Object.keys(content)) {
    if (!FILE_FIELDS.includes(field)) {
      problems.push({
        code: "unknown-field",
        field,
        message: `unknown top-level field "${field}"; only "version" and "harnesses" are allowed`,
      });
    }
  }

  if (!isPlainObject(content.harnesses)) {
    problems.push({
      code: "invalid-shape",
      field: "harnesses",
      message: `"harnesses" must be an object keyed by harness id`,
    });
    return invalid(problems);
  }

  for (const id of Object.keys(content.harnesses).sort()) {
    validateId(id, builtIns, problems);
    const harness = validateDeclaration(
      id,
      content.harnesses[id],
      owned,
      problems,
    );
    if (harness) harnesses.push(harness);
  }

  return problems.length > 0 ? invalid(problems) : { ok: true, harnesses };
}

/**
 * Validates the text of a declarations file, for content that is not on disk
 * at its usual place: a merge result, a proposed replacement.
 */
export function parseHarnessDeclarations(
  text: string,
  builtIns: readonly AgentDef[] = AGENT_DEFS,
): HarnessDeclarationsResult {
  let content: unknown;
  try {
    // Windows editors may save a byte-order mark, which JSON.parse refuses.
    content = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return invalid([
      {
        code: "malformed-json",
        message: `${HARNESS_DECLARATIONS_FILE} is not valid JSON: ${detail}`,
      },
    ]);
  }
  return validateHarnessDeclarations(content, builtIns);
}

/**
 * The raw declarations file at the root of the sync repo. A link or a
 * directory at its place is never read through: it could lead outside the
 * clone. Throws on a read error other than the file being absent.
 */
export type DeclarationsFile =
  | { state: "absent" }
  | { state: "not-regular" }
  | { state: "present"; bytes: Buffer };

export function readDeclarationsFile(configDir: string): DeclarationsFile {
  const filePath = join(configDir, HARNESS_DECLARATIONS_FILE);
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { state: "absent" };
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { state: "not-regular" };
  return { state: "present", bytes: readFileSync(filePath) };
}

/**
 * Reads and validates the declarations file at the root of the sync repo.
 * An absent file declares nothing; any other failure is a problem, so an
 * invalid file never reads as "nothing declared". Never throws.
 */
export function readHarnessDeclarations(
  configDir: string,
  builtIns: readonly AgentDef[] = AGENT_DEFS,
): HarnessDeclarationsResult {
  let file: DeclarationsFile;
  try {
    file = readDeclarationsFile(configDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return invalid([
      {
        code: "unreadable",
        message: `${HARNESS_DECLARATIONS_FILE} could not be read: ${detail}`,
      },
    ]);
  }
  if (file.state === "absent") return { ok: true, harnesses: [] };
  if (file.state === "not-regular") {
    return invalid([
      {
        code: "unreadable",
        message: `${HARNESS_DECLARATIONS_FILE} must be a regular file`,
      },
    ]);
  }
  return parseHarnessDeclarations(file.bytes.toString("utf8"), builtIns);
}

function invalid(problems: DeclarationProblem[]): HarnessDeclarationsResult {
  return { ok: false, problems };
}

function validateId(
  id: string,
  builtIns: readonly AgentDef[],
  problems: DeclarationProblem[],
): void {
  if (!HARNESS_ID_PATTERN.test(id)) {
    problems.push({
      code: "invalid-id",
      harness: id,
      message: `harness "${id}": an id is lowercase letters, digits and hyphens, starts with a letter and is at most 32 characters`,
    });
  } else if (WINDOWS_DEVICE_NAME.test(id)) {
    problems.push({
      code: "invalid-id",
      harness: id,
      message: `harness "${id}": an id cannot be a Windows device name, because it becomes a filename`,
    });
  } else if (
    BUILT_IN_OVERLAY_IDS.includes(id) ||
    builtIns.some((builtIn) => builtIn.id === id)
  ) {
    problems.push({
      code: "reserved-id",
      harness: id,
      message: `harness "${id}": this id belongs to a built-in harness; choose another`,
    });
  }
}

function validateDeclaration(
  id: string,
  declaration: unknown,
  owned: OwnedPath[],
  problems: DeclarationProblem[],
): CustomHarness | null {
  if (!isPlainObject(declaration)) {
    problems.push({
      code: "invalid-shape",
      harness: id,
      message: `harness "${id}": the declaration must be an object`,
    });
    return null;
  }

  for (const field of Object.keys(declaration)) {
    if (!DECLARATION_FIELDS.includes(field)) {
      problems.push({
        code: "unknown-field",
        harness: id,
        field,
        message: `harness "${id}": unknown field "${field}"; only "name", "instructionsFile" and "syncPaths" are allowed`,
      });
    }
  }

  const { name, instructionsFile, syncPaths } = declaration;

  if (name !== undefined && (typeof name !== "string" || name === "")) {
    problems.push({
      code: "invalid-shape",
      harness: id,
      field: "name",
      message: `harness "${id}": "name" must be a non-empty string`,
    });
  }

  if (instructionsFile !== undefined && typeof instructionsFile !== "string") {
    problems.push({
      code: "invalid-shape",
      harness: id,
      field: "instructionsFile",
      message: `harness "${id}": "instructionsFile" must be one path string`,
    });
  }

  const paths: string[] = [];
  if (syncPaths !== undefined) {
    if (Array.isArray(syncPaths) && syncPaths.every((p) => typeof p === "string")) {
      paths.push(...(syncPaths as string[]));
    } else {
      problems.push({
        code: "invalid-shape",
        harness: id,
        field: "syncPaths",
        message: `harness "${id}": "syncPaths" must be an array of path strings`,
      });
    }
  }

  // A field of the wrong type is reported as such, not as a missing path.
  const declaresNothing =
    instructionsFile === undefined &&
    (syncPaths === undefined || (Array.isArray(syncPaths) && syncPaths.length === 0));
  if (declaresNothing) {
    problems.push({
      code: "no-paths",
      harness: id,
      message: `harness "${id}": declare at least one of "instructionsFile" and "syncPaths"`,
    });
  }

  if (typeof instructionsFile === "string") {
    validatePath(id, "instructionsFile", instructionsFile, owned, problems);
  }
  for (const path of paths) {
    validatePath(id, "syncPaths", path, owned, problems);
  }

  const harness: CustomHarness = {
    id,
    name: typeof name === "string" && name !== "" ? name : id,
    syncPaths: paths,
  };
  if (typeof instructionsFile === "string") {
    harness.instructionsFile = instructionsFile;
  }
  return harness;
}

function describePath(id: string, field: HarnessPathField, path: string): string {
  const label = field === "syncPaths" ? "syncPaths entry" : "instructionsFile";
  return `harness "${id}": ${label} ${JSON.stringify(path)}`;
}

/** The reasons a path is not portable (path rule 1); empty when it is. */
function portabilityFaults(path: string): string[] {
  if (path === "") return ["it is empty"];

  const faults = new Set<string>();
  if (path.includes("\\")) {
    faults.add("it contains a backslash (use forward slashes)");
  }
  const absolute = path.startsWith("/") || /^[A-Za-z]:/.test(path);
  if (absolute) {
    faults.add("it is absolute (paths are relative to the home directory)");
  }

  // An absolute path already has its fault; its root is not a segment.
  for (const segment of path.split("/").slice(absolute ? 1 : 0)) {
    const quoted = JSON.stringify(segment);
    if (segment === "") {
      faults.add("it has an empty segment");
    } else if (segment === "." || segment === "..") {
      faults.add(`it has a "${segment}" segment`);
    } else if (WINDOWS_FORBIDDEN_CHARACTER.test(segment)) {
      faults.add(
        `segment ${quoted} has a character Windows forbids (< > : " | ? * or a control character)`,
      );
    } else if (/[. ]$/.test(segment)) {
      faults.add(`segment ${quoted} ends with a dot or a space, which Windows forbids`);
    } else if (WINDOWS_DEVICE_NAME.test(segment.split(".")[0]!.toLowerCase())) {
      faults.add(`segment ${quoted} is a Windows device name`);
    }
  }
  return [...faults];
}

/** How `path` collides with a path already owned, or null when it does not. */
function describeOverlap(
  id: string,
  path: string,
  other: OwnedPath,
): string | null {
  let relation: string;
  if (pathKey(path) === pathKey(other.path)) relation = "duplicates";
  else if (isAtOrInside(path, other.path)) relation = "is inside";
  else if (isAtOrInside(other.path, path)) relation = "contains";
  else return null;

  let owner: string;
  if (other.builtIn) owner = `built-in harness "${other.owner}"`;
  else if (other.owner === id) owner = `its own ${other.field}`;
  else owner = `harness "${other.owner}"`;
  return `${relation} ${JSON.stringify(other.path)} of ${owner}`;
}

/**
 * Checks one declared path against the path rules, then records it as owned.
 * A path that is not portable is compared with nothing: it has no reliable
 * segments.
 */
function validatePath(
  id: string,
  field: HarnessPathField,
  path: string,
  owned: OwnedPath[],
  problems: DeclarationProblem[],
): void {
  const subject = describePath(id, field, path);

  const faults = portabilityFaults(path);
  if (faults.length > 0) {
    problems.push({
      code: "path-not-portable",
      harness: id,
      field,
      path,
      message: `${subject} is not portable: ${faults.join("; ")}`,
    });
    return;
  }

  const segments = pathKey(path).split("/");

  if (segments.length < 2) {
    problems.push({
      code: "path-at-home-root",
      harness: id,
      field,
      path,
      message: `${subject} sits at the home root; a path must be at least two segments deep`,
    });
  }

  if (RESERVED_FIRST_SEGMENTS.includes(segments[0]!)) {
    problems.push({
      code: "path-reserved",
      harness: id,
      field,
      path,
      message: `${subject} starts with "${segments[0]}", which git-agents reserves`,
    });
  }

  const denied = CREDENTIAL_DENYLIST.find((location) =>
    isAtOrInside(path, location),
  );
  if (denied !== undefined) {
    problems.push({
      code: "path-denylisted",
      harness: id,
      field,
      path,
      message: `${subject} is in the credential location "${denied}", which is never synced`,
    });
  }

  const overlaps = owned
    .map((other) => describeOverlap(id, path, other))
    .filter((overlap) => overlap !== null);
  if (overlaps.length > 0) {
    problems.push({
      code: "path-overlap",
      harness: id,
      field,
      path,
      message: `${subject} ${overlaps.join(", ")}; a path has one owner, with no duplicate and no nesting`,
    });
  }
  owned.push({ owner: id, builtIn: false, field, path });
}
