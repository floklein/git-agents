import { existsSync, readFileSync } from "node:fs";
import { getLocalSyncPath } from "../utils/config";
import {
  GENERATED_TARGETS,
  hashContent,
  readCanonical,
  withTrailingNewline,
  type CanonicalContent,
  type GeneratedTarget,
} from "./canonical";

export type MarkerParse = {
  core: { version: string; content: string } | null;
  overlay: { harness: string; version: string; content: string } | null;
  outside: string;
  state: "parsed" | "absent" | "mangled";
};

const BEGIN_CORE = /<!-- ga:begin core v=([0-9a-f]+) -->\n/;
const END_CORE = "<!-- ga:end core -->\n";
const BEGIN_OVERLAY = /<!-- ga:begin overlay harness=([a-z]+) v=([0-9a-f]+) -->\n/;
const END_OVERLAY = "<!-- ga:end overlay -->\n";

// Missing or half-open markers degrade the whole file to unattributed
// content rather than guessing at block boundaries.
export function parseGeneratedFile(content: string): MarkerParse {
  const hasAnyMarker = content.includes("<!-- ga:");
  if (!hasAnyMarker) {
    return { core: null, overlay: null, outside: content, state: "absent" };
  }

  const mangled: MarkerParse = {
    core: null,
    overlay: null,
    outside: content,
    state: "mangled",
  };

  const beginCore = BEGIN_CORE.exec(content);
  if (!beginCore) return mangled;
  const coreStart = beginCore.index + beginCore[0].length;
  const coreEnd = content.indexOf(END_CORE, coreStart);
  if (coreEnd === -1) return mangled;

  const core = { version: beginCore[1]!, content: content.slice(coreStart, coreEnd) };
  let outside =
    content.slice(0, beginCore.index) +
    content.slice(coreEnd + END_CORE.length);

  let overlay: MarkerParse["overlay"] = null;
  const beginOverlay = BEGIN_OVERLAY.exec(outside);
  if (beginOverlay) {
    const overlayStart = beginOverlay.index + beginOverlay[0].length;
    const overlayEnd = outside.indexOf(END_OVERLAY, overlayStart);
    if (overlayEnd === -1) return mangled;
    overlay = {
      harness: beginOverlay[1]!,
      version: beginOverlay[2]!,
      content: outside.slice(overlayStart, overlayEnd),
    };
    outside =
      outside.slice(0, beginOverlay.index) +
      outside.slice(overlayEnd + END_OVERLAY.length);
  }

  if (outside.includes("<!-- ga:")) return mangled;

  return { core, overlay, outside, state: "parsed" };
}

export type GatherRegion =
  | { attribution: "core"; changed: boolean; content: string; canonical: string }
  | {
      attribution: "overlay";
      changed: boolean;
      content: string;
      canonical: string | null;
    }
  | { attribution: "unattributed"; content: string };

export type GatherFile = {
  harness: GeneratedTarget["harness"];
  syncPath: string;
  path: string;
  present: boolean;
  markers: "parsed" | "absent" | "mangled";
  generatedFromVersion: string | null;
  regions: GatherRegion[];
};

export type GatherResult = {
  canonicalVersion: string | null;
  core: string | null;
  overlays: Record<string, string>;
  files: GatherFile[];
  inputs: {
    canonicalVersion: string | null;
    fileHashes: Record<string, string | null>;
  };
};

function gatherFileRegions(
  canonical: CanonicalContent | null,
  harness: GeneratedTarget["harness"],
  rawContent: string,
): Pick<GatherFile, "markers" | "generatedFromVersion" | "regions"> {
  // CRLF conversion by editors or autocrlf must not mangle attribution.
  const content = rawContent.replace(/\r\n/g, "\n");

  if (canonical === null) {
    return {
      markers: "absent",
      generatedFromVersion: null,
      regions:
        content.trim() === ""
          ? []
          : [{ attribution: "unattributed", content }],
    };
  }

  const parsed = parseGeneratedFile(content);
  const overlayMismatch =
    parsed.overlay !== null && parsed.overlay.harness !== harness;
  if (parsed.state !== "parsed" || overlayMismatch) {
    return {
      markers: parsed.state === "parsed" ? "mangled" : parsed.state,
      generatedFromVersion: null,
      regions:
        content.trim() === ""
          ? []
          : [{ attribution: "unattributed", content }],
    };
  }

  const regions: GatherRegion[] = [];
  const canonicalOverlay = canonical.overlays[harness] ?? null;

  regions.push({
    attribution: "core",
    changed: parsed.core!.content !== withTrailingNewline(canonical.core),
    content: parsed.core!.content,
    canonical: canonical.core,
  });
  if (parsed.overlay !== null || canonicalOverlay !== null) {
    const overlayContent = parsed.overlay?.content ?? "";
    regions.push({
      attribution: "overlay",
      changed:
        canonicalOverlay === null
          ? overlayContent !== ""
          : overlayContent !== withTrailingNewline(canonicalOverlay),
      content: overlayContent,
      canonical: canonicalOverlay,
    });
  }
  if (parsed.outside.trim() !== "") {
    regions.push({ attribution: "unattributed", content: parsed.outside });
  }

  return {
    markers: "parsed",
    generatedFromVersion: parsed.core!.version,
    regions,
  };
}

export function gatherDrift(configDir: string, homeDir: string): GatherResult {
  const canonical = readCanonical(configDir);
  const fileHashes: Record<string, string | null> = {};

  const files = GENERATED_TARGETS.map((target): GatherFile => {
    const path = getLocalSyncPath(target.syncPath, homeDir);
    const present = existsSync(path);
    const content = present ? readFileSync(path, "utf8") : null;
    fileHashes[target.harness] = content === null ? null : hashContent(content);

    if (content === null) {
      return {
        harness: target.harness,
        syncPath: target.syncPath,
        path,
        present: false,
        markers: "absent",
        generatedFromVersion: null,
        regions: [],
      };
    }

    return {
      harness: target.harness,
      syncPath: target.syncPath,
      path,
      present: true,
      ...gatherFileRegions(canonical, target.harness, content),
    };
  });

  return {
    canonicalVersion: canonical?.version ?? null,
    core: canonical?.core ?? null,
    overlays: Object.fromEntries(
      Object.entries(canonical?.overlays ?? {}).filter(
        ([, value]) => value !== undefined,
      ),
    ) as Record<string, string>,
    files,
    inputs: {
      canonicalVersion: canonical?.version ?? null,
      fileHashes,
    },
  };
}

export type DriftState = "none" | "drifted" | "unattributed" | "missing";

export function driftStateOf(file: GatherFile): DriftState {
  if (!file.present) return "missing";
  if (
    file.markers !== "parsed" ||
    file.regions.some((region) => region.attribution === "unattributed")
  ) {
    return file.regions.length === 0 ? "none" : "unattributed";
  }
  if (
    file.regions.some(
      (region) => region.attribution !== "unattributed" && region.changed,
    )
  ) {
    return "drifted";
  }
  return "none";
}
