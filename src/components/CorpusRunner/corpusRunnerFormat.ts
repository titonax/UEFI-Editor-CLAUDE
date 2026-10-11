import { type CorpusTabOperation } from "../scripts/corpusReport";
import { inspectAmiFirmwareBytes } from "../scripts/amiFirmwareImage";
import { type FrameworkIfrInventory } from "../scripts/ifrParser";
import { reportNavigationDetected } from "../scripts/corpusReport";
import { type CorpusFileStatus, type CorpusRunEntry, type CorpusStageStatus, type CorpusVolumeCounts } from "../scripts/corpusDashboard";
import { type KnowledgeVerdict, classifyEntry } from "../../knowledge/corpusKnowledge";
import { knownCases } from "../../knowledge";

// Pure helpers of the corpus runner screen: labels and colours, size and
// generation text, the run totals and the CSV export.
export const MAX_FIRMWARE_BYTES = 512 * 1024 * 1024;


export const corpusStatusLabels: Record<CorpusFileStatus, string> = {
  recognized: "Recognized",
  partial: "Partial",
  unsupported: "Unsupported",
  failed: "Failed",
};


export function statusColor(status: CorpusFileStatus) {
  if (status === "recognized") return "green";
  if (status === "partial") return "yellow";
  if (status === "unsupported") return "gray";
  return "red";
}


export function stageColor(status: CorpusStageStatus) {
  if (status === "passed") return "green";
  if (status === "warning") return "yellow";
  if (status === "failed") return "red";
  if (status === "blocked") return "orange";
  return "gray";
}


export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}


export function frameworkInventoryEvidence(inventory: FrameworkIfrInventory) {
  return [
    `${String(inventory.formSets)} FormSet(s)`,
    `${String(inventory.forms)} form(s)`,
    `${String(inventory.references)} reference(s)`,
  ];
}


export function generationLabel(entry: CorpusRunEntry) {
  const assessment = entry.generation;
  if (!assessment) return "generation unresolved";
  if (assessment.conflict) return "generation conflict";
  if (assessment.generation === "aptio-iv") return "probable Aptio IV";
  if (assessment.generation === "aptio-v") return "probable Aptio V";
  return "generation unresolved";
}


export function entryTotals(entry: CorpusRunEntry) {
  const ops = entry.report?.tabOperations ?? [];
  return {
    forms: entry.report?.counts.forms ?? 0,
    refs: entry.report?.counts.refs ?? 0,
    hide: ops.filter((op) => op.hide.available).length,
    show: ops.filter((op) => op.show.available).length,
  };
}


export function summarizeRun(entries: CorpusRunEntry[]) {
  const hashes = entries.flatMap((entry) => (entry.sha256 ? [entry.sha256] : []));
  const uniqueFiles = new Set(hashes).size + entries.length - hashes.length;
  // "unsupported" now covers images this editor correctly identified as not
  // AMI Aptio (Award/Phoenix/Insyde/other UEFI/non-BIOS) - genuinely
  // recognized, but never AMI-extracted, so it belongs with "failed" here,
  // not with "recognized"/"partial".
  const extracted = entries.filter(
    (entry) => entry.status === "recognized" || entry.status === "partial",
  ).length;
  const navigationResolved = entries.filter((entry) =>
    reportNavigationDetected(entry.report),
  ).length;
  const hiiEditable = entries.filter((entry) => {
    const totals = entryTotals(entry);
    return totals.hide + totals.show > 0;
  }).length;
  const percentage = (numerator: number, denominator: number) =>
    denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10;
  return {
    files: entries.length,
    uniqueFiles,
    recognized: entries.filter((entry) => entry.status === "recognized").length,
    partial: entries.filter((entry) => entry.status === "partial").length,
    unsupported: entries.filter((entry) => entry.status === "unsupported").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    extractionRate: percentage(extracted, entries.length),
    navigationRate: percentage(navigationResolved, extracted),
    hiiEditRate: percentage(hiiEditable, extracted),
  };
}


// What the shallow preflight scan counted, kept on the entry so the image can
// be fingerprinted against the recorded firmware cases.
export function volumeCounts(preflight: ReturnType<typeof inspectAmiFirmwareBytes>): CorpusVolumeCounts {
  return {
    firmwareVolumes: preflight.firmwareVolumes.length,
    ffs2Volumes: preflight.ffs2Volumes.length,
    ffs3Volumes: preflight.ffs3Volumes.length,
    directSetupFiles: preflight.setupFfs.length,
  };
}


export function knowledgeBadge(verdict: KnowledgeVerdict) {
  switch (verdict.kind) {
    case "exact":
      return { color: "teal", label: "Known case", title: `Same SHA-256 as case ${verdict.case.id}` };
    case "similar":
      return {
        color: "yellow",
        label: `≈ ${String(Math.round(verdict.similarity * 100))}% like ${verdict.case.id}`,
        title: `Structural similarity over ${String(verdict.compared)} comparable fields; not a probability that it is the same kind of firmware.`,
      };
    case "novel":
      return { color: "grape", label: "New case", title: "No recorded case matches this image's structure." };
  }
}


export function csvCell(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}


export function entriesToCsv(entries: CorpusRunEntry[]) {
  const header = [
    "file",
    "sha256",
    "bytes",
    "status",
    "container",
    "generation",
    "contexts",
    "forms",
    "refs",
    "single_formset_navigation_status",
    "root_visibility_status",
    "hide_available",
    "show_available",
    "reconstruction_complete",
    "vendor_guess",
    "vendor_evidence",
    "brand",
    "brand_basis",
    "brand_navigation_outcome",
    "phoenix_legacy_format",
    "phoenix_legacy_module_count",
    "phoenix_uefi_debug_modules",
    "knowledge",
    "knowledge_case",
    "failure",
  ];
  const rows = entries.map((entry) => {
    const totals = entryTotals(entry);
    const verdict = classifyEntry(entry, knownCases);
    return [
      entry.fileName,
      entry.sha256,
      entry.size,
      entry.status,
      entry.container ?? "",
      entry.generation?.generation ?? "",
      entry.contextCount,
      totals.forms,
      totals.refs,
      entry.report?.navigation.status ?? "",
      entry.report?.rootVisibility?.status ?? "",
      totals.hide,
      totals.show,
      entry.reconstructionComplete === undefined ? "" : String(entry.reconstructionComplete),
      entry.vendorGuess?.family ?? "",
      entry.vendorGuess?.evidence.join("; ") ?? "",
      entry.brand?.brand ?? "",
      entry.brand?.basis ?? "",
      entry.brand?.navigationOutcome ?? "",
      entry.phoenixLegacy?.format ?? "",
      entry.phoenixLegacy?.modules.length ?? "",
      entry.phoenixUefi?.debugModules.join("; ") ?? "",
      verdict.kind,
      verdict.kind === "novel" ? "" : verdict.case.id,
      entry.failureMessage ?? "",
    ];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function tabOperationRows(operations: CorpusTabOperation[]) {
  return operations.flatMap((op) => [
    { page: op.name, formId: op.formId, kind: "hide" as const, result: op.hide },
    { page: op.name, formId: op.formId, kind: "show" as const, result: op.show },
  ]);
}
