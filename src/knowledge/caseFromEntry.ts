import { fingerprintFromEntry } from "./fingerprint";
import {
  caseDirectory,
  caseSchemaVersion,
  validateFirmwareCase,
  type CaseStageId,
  type CaseStageStatus,
  type FirmwareCase,
  type FirmwareCaseFeatures,
  type ValidationResult,
} from "./schema";
import type { CorpusRunEntry } from "../components/scripts/corpusDashboard";

const maxText = 200;

function clip(text: string) {
  return text.length > maxText ? text.slice(0, maxText) : text;
}

function featuresFromEntry(entry: CorpusRunEntry): FirmwareCaseFeatures {
  const fingerprint = fingerprintFromEntry(entry);
  const features: FirmwareCaseFeatures = {};
  for (const key of [
    "firmwareVolumes",
    "ffs2Volumes",
    "ffs3Volumes",
    "directSetupFiles",
    "contextCount",
    "formSets",
    "forms",
    "refs",
  ] as const) {
    const value = fingerprint[key];
    if (value !== undefined) features[key] = value;
  }
  if (fingerprint.navigation !== undefined) features.navigation = clip(fingerprint.navigation);
  return features;
}

// Reshapes what the corpus runner measured for one image into a case. It
// records metadata only: the SHA-256, sizes, counts, stage outcomes and short
// codes. Nothing is re-analysed, nothing is inferred, and what was never
// observed stays absent. The result is validated before it is returned, so a
// case this produces is one `npm run cases:check` accepts.
export function caseFromEntry(entry: CorpusRunEntry): ValidationResult<FirmwareCase> {
  if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
    return {
      ok: false,
      errors: ["This image has no SHA-256 (it could not be read), and the SHA-256 is a case's identity."],
    };
  }

  const family = entry.vendorGuess?.family ?? "unknown";
  const reported = entry.generation;
  // A reported generation conflict is kept as a blocker rather than settled,
  // and a generation is only recorded when it comes with evidence.
  const generationResolved =
    reported !== undefined &&
    reported.generation !== "unresolved" &&
    reported.confidence !== "unresolved" &&
    !reported.conflict;
  const blockers = entry.reconstructionBlockers.map(clip);
  if (reported?.conflict) blockers.push("generation-conflict");

  const stages: Partial<Record<CaseStageId, CaseStageStatus>> = {};
  for (const stage of entry.stages) stages[stage.id] = stage.status;

  const notes: string[] = [];
  if (entry.failureMessage) notes.push(clip(`Failure: ${entry.failureMessage}`));

  const candidate: FirmwareCase = {
    schemaVersion: caseSchemaVersion,
    id: `${caseDirectory(family)}-${entry.sha256.slice(0, 8)}`,
    sha256: entry.sha256,
    size: entry.size,
    names: [clip(entry.fileName)],
    vendorFamily: family,
    container: entry.container ?? "unknown",
    generation: generationResolved ? reported.generation : "unresolved",
    generationEvidence: generationResolved ? reported.confidence : "unresolved",
    features: featuresFromEntry(entry),
    ...(entry.stages.length > 0 ? { stages } : {}),
    blockers,
    source: "corpus-runner",
    ...(notes.length > 0 ? { notes } : {}),
  };
  return validateFirmwareCase(candidate);
}

// Stable, diff-friendly JSON: two-space indent and a trailing newline.
export function serializeCase(value: FirmwareCase): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Where a case file lives in the repository: one directory per family, one
// file per case, named after the id.
export function caseFilePath(value: FirmwareCase): string {
  return `src/knowledge/cases/${caseDirectory(value.vendorFamily)}/${value.id}.json`;
}
