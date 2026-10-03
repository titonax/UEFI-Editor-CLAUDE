import type {
  AmiFirmwareGeneration,
  DetectionConfidence,
  FirmwareContainer,
  FirmwareVendorFamily,
} from "../components/scripts/amiFirmwareImage";

// A firmware case is metadata about one firmware image the editor has
// analysed: its identity (SHA-256), what the structural analysers observed and
// how far the editor got. It never contains firmware bytes. A field that was
// not observed is absent, never guessed: absence means "unknown".
//
// A case is a recorded observation, not a rule. The structural analysers
// (amiFirmwareImage.ts, aptioIvExtractor.ts, ...) keep deciding what an image
// is by reading it; cases only let the editor say "this resembles those
// images". The manufacturer or vendor family is informational and must never
// select a code path.

export const caseSchemaVersion = 1;

export const vendorFamilies: readonly FirmwareVendorFamily[] = [
  "ami-aptio",
  "award",
  "phoenix",
  "phoenix-uefi",
  "insyde",
  "ami-legacy",
  "uefi-generic",
  "embedded-non-bios",
  "legacy-framework-hii",
  "intel-me",
  "non-firmware",
  "unknown",
];
export const containers: readonly FirmwareContainer[] = [
  "intel-flash",
  "firmware-volume-image",
  "vendor-image",
  "phoenix-rom",
  "unknown",
];
export const generations: readonly AmiFirmwareGeneration[] = ["aptio-iv", "aptio-v", "unresolved"];
export const confidences: readonly DetectionConfidence[] = ["confirmed", "probable", "unresolved"];

export type CaseStageId =
  | "preflight"
  | "extraction"
  | "hii"
  | "navigation"
  | "editability"
  | "reconstruction";
export const caseStageIds: readonly CaseStageId[] = [
  "preflight",
  "extraction",
  "hii",
  "navigation",
  "editability",
  "reconstruction",
];
export type CaseStageStatus = "passed" | "warning" | "failed" | "blocked" | "not-run";
export const caseStageStatuses: readonly CaseStageStatus[] = [
  "passed",
  "warning",
  "failed",
  "blocked",
  "not-run",
];

// Counts and flags observed on the image. Every field is optional: a case only
// records what the analysers actually reported.
export interface FirmwareCaseFeatures {
  firmwareVolumes?: number;
  // Firmware volumes whose file system is FFS2 / FFS3.
  ffs2Volumes?: number;
  ffs3Volumes?: number;
  // Setup FFS files the outer byte scan can see without decompressing anything.
  directSetupFiles?: number;
  contextCount?: number;
  formSets?: number;
  forms?: number;
  refs?: number;
  // The navigation mechanism the detector reported (a short code, not prose).
  navigation?: string;
}

export interface FirmwareCase {
  schemaVersion: typeof caseSchemaVersion;
  // Stable slug, "<family>-<first 8 hex of sha256>".
  id: string;
  // Lower-case hex SHA-256 of the whole image: the identity of the case.
  sha256: string;
  size: number;
  // File names this exact image was seen under (informational).
  names: string[];
  // Informational only: never a reason to choose a parser.
  vendorFamily: FirmwareVendorFamily;
  container: FirmwareContainer;
  generation: AmiFirmwareGeneration;
  generationEvidence: DetectionConfidence;
  features: FirmwareCaseFeatures;
  // Per-stage outcome, when the image was run through the corpus runner.
  stages?: Partial<Record<CaseStageId, CaseStageStatus>>;
  // Short codes naming what keeps the image from going further.
  blockers: string[];
  // Where this observation came from, e.g. a docs page or "corpus-runner".
  source: string;
  notes?: string[];
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

const maxTextLength = 200;
const idPattern = /^[a-z0-9-]+-[0-9a-f]{8}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const topLevelKeys = new Set([
  "schemaVersion",
  "id",
  "sha256",
  "size",
  "names",
  "vendorFamily",
  "container",
  "generation",
  "generationEvidence",
  "features",
  "stages",
  "blockers",
  "source",
  "notes",
]);
const featureNumberKeys = [
  "firmwareVolumes",
  "ffs2Volumes",
  "ffs3Volumes",
  "directSetupFiles",
  "contextCount",
  "formSets",
  "forms",
  "refs",
] as const;
const featureKeys = new Set<string>([...featureNumberKeys, "navigation"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isShortText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxTextLength;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function textList(value: unknown, label: string, errors: string[], minimum: number) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return;
  }
  if (value.length < minimum) errors.push(`${label} must have at least ${String(minimum)} entr${minimum === 1 ? "y" : "ies"}.`);
  for (const entry of value) {
    if (!isShortText(entry)) {
      errors.push(`${label} entries must be non-empty text of at most ${String(maxTextLength)} characters.`);
      return;
    }
  }
}

// Strict structural validation: unknown keys are rejected (so a stray blob of
// bytes cannot ride along), every enum is checked and every text field is
// short. It checks shape, not truth.
export function validateFirmwareCase(value: unknown): ValidationResult<FirmwareCase> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["A case must be an object."] };

  for (const key of Object.keys(value)) {
    if (!topLevelKeys.has(key)) errors.push(`Unknown field "${key}".`);
  }
  if (value.schemaVersion !== caseSchemaVersion) {
    errors.push(`schemaVersion must be ${String(caseSchemaVersion)}.`);
  }
  if (typeof value.id !== "string" || !idPattern.test(value.id)) {
    errors.push('id must look like "<family>-<8 hex characters>".');
  }
  if (typeof value.sha256 !== "string" || !sha256Pattern.test(value.sha256)) {
    errors.push("sha256 must be 64 lower-case hex characters.");
  } else if (typeof value.id === "string" && !value.id.endsWith(`-${value.sha256.slice(0, 8)}`)) {
    errors.push("id must end with the first 8 hex characters of sha256.");
  }
  if (typeof value.size !== "number" || !Number.isInteger(value.size) || value.size <= 0) {
    errors.push("size must be a positive integer.");
  }
  textList(value.names, "names", errors, 1);
  if (!oneOf(vendorFamilies, value.vendorFamily)) errors.push("vendorFamily is not a known family.");
  if (!oneOf(containers, value.container)) errors.push("container is not a known container.");
  if (!oneOf(generations, value.generation)) errors.push("generation is not a known generation.");
  if (!oneOf(confidences, value.generationEvidence)) {
    errors.push("generationEvidence is not a known evidence level.");
  }
  if (
    value.generation !== "unresolved" &&
    value.generationEvidence === "unresolved"
  ) {
    errors.push("A resolved generation needs evidence other than unresolved.");
  }
  if (value.generation === "unresolved" && value.generationEvidence !== "unresolved") {
    errors.push("An unresolved generation cannot claim evidence.");
  }

  if (!isRecord(value.features)) {
    errors.push("features must be an object.");
  } else {
    for (const [key, entry] of Object.entries(value.features)) {
      if (!featureKeys.has(key)) errors.push(`Unknown feature "${key}".`);
      else if (key === "navigation" ? !isShortText(entry) : !isCount(entry)) {
        errors.push(`Feature "${key}" has an invalid value.`);
      }
    }
  }

  if (value.stages !== undefined) {
    if (!isRecord(value.stages)) {
      errors.push("stages must be an object.");
    } else {
      for (const [stage, status] of Object.entries(value.stages)) {
        if (!oneOf(caseStageIds, stage)) errors.push(`Unknown stage "${stage}".`);
        else if (!oneOf(caseStageStatuses, status)) errors.push(`Stage "${stage}" has an unknown status.`);
      }
    }
  }

  textList(value.blockers, "blockers", errors, 0);
  if (!isShortText(value.source)) errors.push("source must be short, non-empty text.");
  if (value.notes !== undefined) textList(value.notes, "notes", errors, 0);

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as unknown as FirmwareCase };
}

// Cross-case rules for a whole collection: one case per image, one id per case.
export function findCollectionProblems(cases: readonly FirmwareCase[]): string[] {
  const problems: string[] = [];
  const ids = new Map<string, string>();
  const hashes = new Map<string, string>();
  for (const entry of cases) {
    const sameId = ids.get(entry.id);
    if (sameId !== undefined) problems.push(`Duplicate id ${entry.id}.`);
    ids.set(entry.id, entry.id);
    const sameImage = hashes.get(entry.sha256);
    if (sameImage !== undefined) {
      problems.push(`Cases ${sameImage} and ${entry.id} describe the same image (${entry.sha256}).`);
    }
    hashes.set(entry.sha256, entry.id);
  }
  return problems;
}
