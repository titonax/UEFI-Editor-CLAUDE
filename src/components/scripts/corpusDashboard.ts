import type { AmiGenerationAssessment, FirmwareContainer, FirmwareVendorGuess } from "./amiFirmwareImage";
import type { BrandClassification } from "./brandKnowledge";
import { reportNavigationDetected, type CorpusReport } from "./corpusReport";

// The browser corpus runner's per-file result shape - richer than
// CorpusReport (see corpusReport.ts), which only ever describes a
// successfully-parsed AMI Data model. A CorpusRunEntry also covers images
// that never got that far: their preflight/extraction stage outcomes,
// vendor/brand guesses, and the failure message, if any.
export type CorpusStageId =
  | "preflight"
  | "extraction"
  | "hii"
  | "navigation"
  | "editability"
  | "reconstruction";
export type CorpusStageStatus = "passed" | "warning" | "failed" | "blocked" | "not-run";
export type CorpusFileStatus = "recognized" | "partial" | "unsupported" | "failed";

export interface CorpusStageResult {
  id: CorpusStageId;
  status: CorpusStageStatus;
  detail: string;
}

export interface CorpusRunEntry {
  fileName: string;
  size: number;
  sha256: string;
  status: CorpusFileStatus;
  container?: FirmwareContainer;
  generation?: AmiGenerationAssessment;
  contextCount: number;
  reconstructionComplete?: boolean;
  reconstructionBlockers: string[];
  stages: CorpusStageResult[];
  report?: CorpusReport;
  failureMessage?: string;
  vendorGuess?: FirmwareVendorGuess;
  brand?: BrandClassification;
}

// A duplicate upload (the same image selected twice, or genuinely identical
// firmware under two filenames) shouldn't be counted twice in any of the
// breakdowns below - an entry that couldn't even be hashed is kept as its
// own case rather than assumed identical to another unhashed failure.
export function distinctEntries(entries: CorpusRunEntry[]) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (!entry.sha256) return true;
    const key = entry.sha256.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type RecognitionBlocker =
  | "reading"
  | "preflight"
  | "extraction"
  | "hii"
  | "navigation"
  | "none";

const recognitionBlockerCategories: RecognitionBlocker[] = [
  "reading",
  "preflight",
  "extraction",
  "hii",
  "navigation",
  "none",
];
const recognitionStageOrder = ["preflight", "extraction", "hii", "navigation"] as const;

function stagePassed(entry: CorpusRunEntry, id: CorpusStageId) {
  return entry.stages.find((stage) => stage.id === id)?.status === "passed";
}

// Which stage first kept this image from being fully recognized - "none"
// only once every stage up to navigation actually passed. A "partial" entry
// (navigation unresolved) pushes its navigation stage as "warning", not
// "passed", so it correctly comes out blocked "at navigation" too - this
// answers "which stage should we improve," which for a partial image is
// exactly the navigation detector, not something further downstream.
export function firstRecognitionBlocker(entry: CorpusRunEntry): RecognitionBlocker {
  if (!entry.sha256) return "reading";
  for (const id of recognitionStageOrder) {
    if (!stagePassed(entry, id)) return id;
  }
  return "none";
}

// preflight always applies; each later stage is only "eligible" once the
// one before it actually ran and passed - an image whose preflight failed
// was never eligible for an extraction pass/fail/warning count at all.
function stageEligible(entry: CorpusRunEntry, id: CorpusStageId) {
  if (id === "preflight") return true;
  if (id === "extraction") return stagePassed(entry, "preflight");
  if (id === "hii") return stagePassed(entry, "extraction");
  return stagePassed(entry, "hii");
}

const allStageIds: CorpusStageId[] = [
  "preflight",
  "extraction",
  "hii",
  "navigation",
  "editability",
  "reconstruction",
];

export interface CorpusDashboardStage {
  id: CorpusStageId;
  eligible: number;
  passed: number;
  warning: number;
  failed: number;
  blocked: number;
  notRun: number;
}

export function stageBreakdown(entries: CorpusRunEntry[]): CorpusDashboardStage[] {
  return allStageIds.map((id) => {
    const stage: CorpusDashboardStage = {
      id,
      eligible: 0,
      passed: 0,
      warning: 0,
      failed: 0,
      blocked: 0,
      notRun: 0,
    };
    for (const entry of entries) {
      if (!stageEligible(entry, id)) continue;
      stage.eligible += 1;
      const status = entry.stages.find((item) => item.id === id)?.status ?? "not-run";
      if (status === "not-run") stage.notRun += 1;
      else stage[status] += 1;
    }
    return stage;
  });
}

function entryHiiEditable(entry: CorpusRunEntry) {
  const ops = entry.report?.tabOperations ?? [];
  return ops.some((op) => op.hide.available || op.show.available);
}

export interface CorpusDashboardCohort {
  label: string;
  cases: number;
  extracted: number;
  navigationResolved: number;
  hiiEditable: number;
  fullImageReady: number;
}

// Groups distinct cases by whatever labelFor returns (firmware family, IFR
// format, manufacturer, container, Aptio generation, ...) and measures the
// same four capabilities for each group, so a whole cohort's shape reads at
// a glance instead of scrolling every individual row.
export function cohortBreakdown(
  entries: CorpusRunEntry[],
  labelFor: (entry: CorpusRunEntry) => string,
): CorpusDashboardCohort[] {
  const byLabel = new Map<string, CorpusDashboardCohort>();
  for (const entry of entries) {
    const label = labelFor(entry);
    const cohort = byLabel.get(label) ?? {
      label,
      cases: 0,
      extracted: 0,
      navigationResolved: 0,
      hiiEditable: 0,
      fullImageReady: 0,
    };
    cohort.cases += 1;
    if (stagePassed(entry, "extraction")) cohort.extracted += 1;
    if (reportNavigationDetected(entry.report)) cohort.navigationResolved += 1;
    if (entryHiiEditable(entry)) cohort.hiiEditable += 1;
    if (entry.reconstructionComplete) cohort.fullImageReady += 1;
    byLabel.set(label, cohort);
  }
  return [...byLabel.values()].sort(
    (left, right) => right.cases - left.cases || left.label.localeCompare(right.label),
  );
}

const extractedStatuses: CorpusFileStatus[] = ["recognized", "partial"];

// Every image that got a real AMI Setup HII, regardless of whether its
// navigation mechanism was ultimately detected - "AMI Aptio" is already
// known for these; a rejected image's own vendorGuess names what it is
// instead, or falls back to "unexpected error" when even that isn't set
// (a genuinely unexpected failure, not a structurally-understood rejection).
export function entryFamilyLabel(entry: CorpusRunEntry): string {
  if (extractedStatuses.includes(entry.status)) return "AMI Aptio";
  return entry.vendorGuess?.label ?? "Unresolved (unexpected error)";
}

export function entryIfrFormatLabel(entry: CorpusRunEntry): string {
  if (extractedStatuses.includes(entry.status)) return "UEFI";
  if (entry.vendorGuess?.family === "legacy-framework-hii") return "Framework";
  return "Unknown";
}

export function entryManufacturerLabel(entry: CorpusRunEntry): string {
  if (!entry.brand) return "Unknown";
  if (entry.brand.brand) return entry.brand.brand;
  return entry.brand.basis === "conflict" ? "Conflict" : "Unknown";
}

export function entryContainerLabel(entry: CorpusRunEntry): string {
  return entry.container ?? "unknown";
}

export function entryGenerationLabel(entry: CorpusRunEntry): string {
  if (!entry.generation) return "unresolved";
  return entry.generation.conflict ? "conflict" : entry.generation.generation;
}

export interface CorpusDashboardBlocker {
  category: RecognitionBlocker;
  cases: number;
  fileNames: string[];
}

export function recognitionBreakdown(entries: CorpusRunEntry[]): CorpusDashboardBlocker[] {
  return recognitionBlockerCategories.map((category) => {
    const fileNames = entries
      .filter((entry) => firstRecognitionBlocker(entry) === category)
      .map((entry) => entry.fileName);
    return { category, cases: fileNames.length, fileNames };
  });
}

// This editor doesn't carry typed error codes end-to-end (see
// aptioIvExtractor.ts's plain Error/message convention), so this classifies
// the small, closed set of messages the corpus runner itself can actually
// throw - anything else is genuinely unexpected and stays "OTHER" rather
// than being guessed at.
export type CorpusFailureCode =
  | "NO_FIRMWARE_VOLUME"
  | "NO_SETUP_FFS"
  | "NO_COHERENT_CONTEXT"
  | "SECTION_DECODE_FAILED"
  | "FRAMEWORK_HII"
  | "EXTRACTION_TIMEOUT"
  | "TOO_LARGE"
  | "OTHER";

function classifyFailureMessage(message: string): CorpusFailureCode {
  if (message.includes("No valid UEFI firmware volumes")) return "NO_FIRMWARE_VOLUME";
  if (message.includes("Setup FFS was not found")) return "NO_SETUP_FFS";
  if (message.includes("No Setup context contains")) return "NO_COHERENT_CONTEXT";
  if (message.includes("Failed to decompress")) return "SECTION_DECODE_FAILED";
  if (message.includes("Only UEFI is supported")) return "FRAMEWORK_HII";
  if (message.includes("Extraction timed out")) return "EXTRACTION_TIMEOUT";
  if (message.includes("Exceeds the")) return "TOO_LARGE";
  return "OTHER";
}

export interface CorpusDashboardFailureCode {
  stage: RecognitionBlocker;
  code: CorpusFailureCode;
  cases: number;
  example: string;
}

export function failureCodeBreakdown(entries: CorpusRunEntry[]): CorpusDashboardFailureCode[] {
  const byKey = new Map<string, CorpusDashboardFailureCode>();
  for (const entry of entries) {
    if (!entry.failureMessage) continue;
    const stage = firstRecognitionBlocker(entry);
    const code = classifyFailureMessage(entry.failureMessage);
    const key = `${stage}:${code}`;
    const existing = byKey.get(key) ?? { stage, code, cases: 0, example: entry.failureMessage };
    existing.cases += 1;
    byKey.set(key, existing);
  }
  return [...byKey.values()].sort(
    (left, right) => right.cases - left.cases || left.stage.localeCompare(right.stage),
  );
}

export interface CorpusDashboardData {
  selected: number;
  completed: number;
  uniqueCases: number;
  duplicateHashes: number;
  unhashedCases: number;
  unknownManufacturer: number;
  stages: CorpusDashboardStage[];
  recognitionBlockers: CorpusDashboardBlocker[];
  failureCodes: CorpusDashboardFailureCode[];
  families: CorpusDashboardCohort[];
  ifrFormats: CorpusDashboardCohort[];
  manufacturers: CorpusDashboardCohort[];
  containers: CorpusDashboardCohort[];
  generations: CorpusDashboardCohort[];
  noHiiEdit: number;
  fullImageBlocked: number;
}

// `selected` (how many files were chosen, before Cancel may have cut the
// run short) can differ from `entries.length` (how many actually finished);
// every rate below is measured over distinct, completed cases only.
export function buildCorpusDashboard(
  entries: CorpusRunEntry[],
  selected = entries.length,
): CorpusDashboardData {
  const unique = distinctEntries(entries);
  return {
    selected,
    completed: entries.length,
    uniqueCases: unique.length,
    duplicateHashes: entries.length - unique.length,
    unhashedCases: unique.filter((entry) => !entry.sha256).length,
    unknownManufacturer: unique.filter((entry) => !entry.brand?.brand).length,
    stages: stageBreakdown(unique),
    recognitionBlockers: recognitionBreakdown(unique),
    failureCodes: failureCodeBreakdown(unique),
    families: cohortBreakdown(unique, entryFamilyLabel),
    ifrFormats: cohortBreakdown(unique, entryIfrFormatLabel),
    manufacturers: cohortBreakdown(unique, entryManufacturerLabel),
    containers: cohortBreakdown(unique, entryContainerLabel),
    generations: cohortBreakdown(unique, entryGenerationLabel),
    noHiiEdit: unique.filter(
      (entry) => extractedStatuses.includes(entry.status) && !entryHiiEditable(entry),
    ).length,
    fullImageBlocked: unique.filter(
      (entry) => extractedStatuses.includes(entry.status) && !entry.reconstructionComplete,
    ).length,
  };
}
