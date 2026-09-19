import React from "react";
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Divider,
  FileInput,
  Group,
  Progress,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import {
  IconBinary,
  IconDownload,
  IconPlayerPlay,
  IconPlayerStop,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { saveAs } from "file-saver";
import {
  inspectAmiFirmwareBytes,
  inspectAmiSetupProfile,
  legacyFrameworkHiiGuess,
  reconcileAmiGeneration,
  sniffNonAmiFailure,
  type AmiGenerationAssessment,
  type FirmwareContainer,
  type FirmwareVendorGuess,
} from "../scripts/amiFirmwareImage";
import { extractFirmwareInWorker } from "../scripts/aptioIvExtractorClient";
import { assessFirmwareReconstruction } from "../scripts/firmwareProvenance";
import { sha256Hex } from "../scripts/hashing";
import { parseData } from "../scripts/ifrParser";
import { buildPopulatedFilesFromArtifacts } from "../scripts/populatedFilesFromArtifacts";
import {
  buildCorpusReport,
  reportNavigationDetected,
  type CorpusReport,
  type CorpusTabOperation,
} from "../scripts/corpusReport";
import s from "./CorpusRunner.module.css";

const MAX_FIRMWARE_BYTES = 512 * 1024 * 1024;

type CorpusStageId = "preflight" | "extraction" | "hii" | "navigation" | "editability" | "reconstruction";
type CorpusStageStatus = "passed" | "warning" | "failed" | "blocked" | "not-run";
type CorpusFileStatus = "recognized" | "partial" | "unsupported" | "failed";

interface CorpusStageResult {
  id: CorpusStageId;
  status: CorpusStageStatus;
  detail: string;
}

interface CorpusRunEntry {
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
  // Only set when this image was rejected for a structurally-understood
  // reason (no firmware volumes at all, or valid UEFI volumes with no AMI
  // Setup module) - this editor's best guess at what it actually is
  // (Award/Phoenix/Insyde/other UEFI/not a PC BIOS), never a parse attempt.
  vendorGuess?: FirmwareVendorGuess;
}

const corpusStatusLabels: Record<CorpusFileStatus, string> = {
  recognized: "Recognized",
  partial: "Partial",
  unsupported: "Unsupported",
  failed: "Failed",
};

function statusColor(status: CorpusFileStatus) {
  if (status === "recognized") return "green";
  if (status === "partial") return "yellow";
  if (status === "unsupported") return "gray";
  return "red";
}

function stageColor(status: CorpusStageStatus) {
  if (status === "passed") return "green";
  if (status === "warning") return "yellow";
  if (status === "failed") return "red";
  if (status === "blocked") return "orange";
  return "gray";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function generationLabel(entry: CorpusRunEntry) {
  const assessment = entry.generation;
  if (!assessment) return "generation unresolved";
  if (assessment.conflict) return "generation conflict";
  if (assessment.generation === "aptio-iv") return "probable Aptio IV";
  if (assessment.generation === "aptio-v") return "probable Aptio V";
  return "generation unresolved";
}

function entryTotals(entry: CorpusRunEntry) {
  const ops = entry.report?.tabOperations ?? [];
  return {
    forms: entry.report?.counts.forms ?? 0,
    refs: entry.report?.counts.refs ?? 0,
    hide: ops.filter((op) => op.hide.available).length,
    show: ops.filter((op) => op.show.available).length,
  };
}

function summarizeRun(entries: CorpusRunEntry[]) {
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

function csvCell(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function entriesToCsv(entries: CorpusRunEntry[]) {
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
    "failure",
  ];
  const rows = entries.map((entry) => {
    const totals = entryTotals(entry);
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
      entry.failureMessage ?? "",
    ];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={s.summary}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={700}>{value}</Text>
    </div>
  );
}

function tabOperationRows(operations: CorpusTabOperation[]) {
  return operations.flatMap((op) => [
    { page: op.name, formId: op.formId, kind: "hide" as const, result: op.hide },
    { page: op.name, formId: op.formId, kind: "show" as const, result: op.show },
  ]);
}

function FileDetails({ entry }: { entry: CorpusRunEntry }) {
  const report = entry.report;
  const totals = entryTotals(entry);
  return (
    <Stack gap="md">
      <Text size="xs" c="dimmed" className={s.hash}>
        SHA-256: {entry.sha256 || "not calculated"}
      </Text>
      <ScrollArea>
        <Table striped withColumnBorders className={s.detailsTable}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Stage</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Detail</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {entry.stages.map((stage) => (
              <Table.Tr key={stage.id}>
                <Table.Td>{stage.id}</Table.Td>
                <Table.Td>
                  <Badge variant="light" color={stageColor(stage.status)}>
                    {stage.status}
                  </Badge>
                </Table.Td>
                <Table.Td>{stage.detail}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      {entry.failureMessage && (
        <Alert
          color={entry.status === "unsupported" ? "gray" : "red"}
          title={entry.status === "unsupported" ? "not AMI Aptio" : "failed"}
        >
          {entry.failureMessage}
        </Alert>
      )}
      {entry.vendorGuess && (
        <Stack gap={4}>
          <Group gap="xs">
            <Badge variant="light" color="gray">
              Vendor guess: {entry.vendorGuess.label}
            </Badge>
          </Group>
          {entry.vendorGuess.evidence.length > 0 && (
            <Text size="xs" c="dimmed">
              Evidence: {entry.vendorGuess.evidence.join(", ")}
            </Text>
          )}
        </Stack>
      )}
      {report && (
        <>
          <Divider />
          <Stack gap="sm">
            <Group gap="xs">
              <Badge
                variant="light"
                color={report.navigation.status === "detected" ? "green" : "yellow"}
              >
                single-FormSet: {report.navigation.mechanism ?? report.navigation.status}
              </Badge>
              {report.rootVisibility && (
                <Badge
                  variant="light"
                  color={report.rootVisibility.status === "detected" ? "green" : "yellow"}
                >
                  root vector: {report.rootVisibility.status}
                </Badge>
              )}
              <Badge
                variant="light"
                color={entry.reconstructionComplete ? "blue" : "orange"}
              >
                provenance {entry.reconstructionComplete ? "complete" : "incomplete"}
              </Badge>
            </Group>
            <SimpleGrid cols={{ base: 2, sm: 4, lg: 7 }} spacing="xs">
              <Metric label="Forms" value={report.counts.forms} />
              <Metric label="FormSets" value={report.counts.formSets} />
              <Metric label="Refs" value={report.counts.refs} />
              <Metric label="Conditions" value={report.counts.conditions} />
              <Metric label="Direct tabs" value={report.navigation.directTabs} />
              <Metric label="Suppressed tabs" value={report.navigation.suppressedTabs} />
              <Metric label="Registered only" value={report.navigation.registeredOnly} />
            </SimpleGrid>
            {report.navigation.reason && (
              <Text size="xs" c="dimmed">
                Single-FormSet navigation: {report.navigation.status} — {report.navigation.reason}
              </Text>
            )}
            {report.rootVisibility && (
              <Text size="xs" c="dimmed">
                Root visibility: {report.rootVisibility.status} — {report.rootVisibility.reason}
              </Text>
            )}
            {report.tabOperations.length > 0 && (
              <ScrollArea>
                <Table striped withColumnBorders className={s.detailsTable}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Page</Table.Th>
                      <Table.Th>Operation</Table.Th>
                      <Table.Th>Availability</Table.Th>
                      <Table.Th>Reason</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {tabOperationRows(report.tabOperations).map((row, index) => (
                      <Table.Tr key={`${row.formId}:${row.kind}:${String(index)}`}>
                        <Table.Td>
                          {row.page}{" "}
                          <Text span c="dimmed" size="xs">
                            {row.formId}
                          </Text>
                        </Table.Td>
                        <Table.Td>{row.kind}</Table.Td>
                        <Table.Td>
                          <Badge color={row.result.available ? "green" : "gray"} variant="light">
                            {row.result.available ? "available" : "blocked"}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">{row.result.reason}</Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
            {totals.hide + totals.show === 0 && (
              <Text size="xs" c="dimmed">
                No Hide/Show operations are available for this image.
              </Text>
            )}
            <Alert color="gray" title="Full-image output remains blocked">
              {entry.reconstructionBlockers.join(" ")}
            </Alert>
          </Stack>
        </>
      )}
    </Stack>
  );
}

// A browser-local batch runner over several real firmware images at once:
// every file goes through the exact same preflight/extraction/parse path
// BiosImageUpload uses for one, and the result is the same structured
// report corpusRunner.node.test.ts writes for a local CLI run (see
// corpusReport.ts) - just gathered here without leaving the browser, and
// without a session ever committing to editing any one of them. Read-only:
// nothing is patched or exported except the reports themselves.
//
// Unlike BiosImageUpload, a multi-context image is never presented for a
// manual slot choice here - that would defeat batching many files at once.
// It silently analyses the first (lowest-offset) context, same as
// extractAptioIvBytes's own default; a context whose companions turned out
// ambiguous still shows up as a warning in that image's own report.
export default function CorpusRunner() {
  const operation = React.useRef(0);
  const cancelRequested = React.useRef(false);
  const [files, setFiles] = React.useState<File[]>([]);
  const [entries, setEntries] = React.useState<CorpusRunEntry[]>([]);
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [progressText, setProgressText] = React.useState("");
  const [cancelled, setCancelled] = React.useState(false);

  const analyseOne = async (file: File): Promise<CorpusRunEntry> => {
    const stages: CorpusStageResult[] = [];
    let sha256 = "";
    // Hoisted so the catch block below can still run the vendor sniffer
    // (see amiFirmwareImage.ts's classifyFirmwareVendor) once extraction
    // fails for a structurally-understood, non-AMI reason - it needs the
    // raw bytes and the preflight's firmware-volume count either way.
    let preflight: ReturnType<typeof inspectAmiFirmwareBytes> | undefined;
    try {
      if (file.size > MAX_FIRMWARE_BYTES) {
        throw new Error("Exceeds the 512 MiB safety limit.");
      }
      const image = new Uint8Array(await file.arrayBuffer());
      sha256 = await sha256Hex(image);

      preflight = inspectAmiFirmwareBytes(image);
      if (preflight.firmwareVolumes.length === 0) {
        stages.push({
          id: "preflight",
          status: "failed",
          detail: "No valid UEFI firmware volumes were found.",
        });
        throw new Error("No valid UEFI firmware volumes were found.");
      }
      stages.push({
        id: "preflight",
        status: "passed",
        detail: `${String(preflight.firmwareVolumes.length)} firmware volume(s), ${preflight.container}.`,
      });

      const extracted = await extractFirmwareInWorker(file);
      stages.push({
        id: "extraction",
        status: "passed",
        detail: `${String(extracted.artifactSets.length)} coherent context(s).`,
      });

      const profile = inspectAmiSetupProfile(extracted.hii, extracted.setupData);
      const generation = reconcileAmiGeneration(preflight, profile);
      const populated = buildPopulatedFilesFromArtifacts(
        extracted,
        file.name,
        generation.generation,
      );
      const data = await parseData(populated);
      data.firmwareFamily =
        generation.generation === "unresolved" ? "ami-aptio" : generation.generation;
      const report = buildCorpusReport(data, file.name);
      stages.push({
        id: "hii",
        status: "passed",
        detail: `${String(report.counts.forms)} form(s), ${String(report.counts.refs)} ref(s).`,
      });

      const singleFormSetDetected = report.navigation.status === "detected";
      const rootVisibilityDetected = report.rootVisibility?.status === "detected";
      const navigationDetected = reportNavigationDetected(report);
      const navigationDetail = singleFormSetDetected
        ? (report.navigation.reason ?? report.navigation.status)
        : rootVisibilityDetected
          ? (report.rootVisibility?.reason ?? "Multi-FormSet root visibility vector detected.")
          : (report.navigation.reason ?? report.navigation.status);
      stages.push({
        id: "navigation",
        status: navigationDetected ? "passed" : "warning",
        detail: navigationDetail,
      });

      const hideAvailable = report.tabOperations.filter((op) => op.hide.available).length;
      const showAvailable = report.tabOperations.filter((op) => op.show.available).length;
      stages.push({
        id: "editability",
        status: hideAvailable + showAvailable > 0 ? "passed" : "warning",
        detail: `Hide available on ${String(hideAvailable)}, Show available on ${String(showAvailable)} page(s).`,
      });

      // writeEnabled is always false right now (see assessFirmwareReconstruction),
      // so this stage is always "blocked" regardless of trace completeness -
      // the detail line still distinguishes a complete trace waiting on
      // recompression/rebuild support from one that's missing a link.
      const reconstruction = assessFirmwareReconstruction(extracted.provenance);
      stages.push({
        id: "reconstruction",
        status: "blocked",
        detail: reconstruction.blockers[0] ?? "Full-image writing is not implemented.",
      });

      const status: CorpusFileStatus = navigationDetected ? "recognized" : "partial";
      return {
        fileName: file.name,
        size: file.size,
        sha256,
        status,
        container: preflight.container,
        generation,
        contextCount: extracted.artifactSets.length,
        reconstructionComplete: reconstruction.traceComplete,
        reconstructionBlockers: reconstruction.blockers,
        stages,
        report,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const id of ["extraction", "hii", "navigation", "editability", "reconstruction"] as const) {
        if (!stages.some((stage) => stage.id === id)) {
          stages.push({ id, status: "not-run", detail: "Not reached." });
        }
      }
      // No firmware volumes at all, valid UEFI volumes with no AMI Setup
      // module, or a Setup module that decoded as legacy Framework rather
      // than UEFI HII, are all structurally-understood "this just isn't
      // (usable) AMI Aptio" outcomes - worth a vendor guess and
      // "unsupported" rather than a blanket "failed", which stays for
      // genuinely unexpected errors (a truncated file, an extraction-worker
      // crash, the size cap).
      const knownNonAmi =
        preflight !== undefined &&
        (preflight.firmwareVolumes.length === 0 || sniffNonAmiFailure(message));
      const vendorGuess = knownNonAmi
        ? message.includes("Only UEFI is supported.")
          ? legacyFrameworkHiiGuess
          : preflight?.vendorGuess
        : undefined;
      return {
        fileName: file.name,
        size: file.size,
        sha256,
        status: knownNonAmi ? "unsupported" : "failed",
        container: preflight?.container,
        contextCount: 0,
        reconstructionBlockers: [],
        stages,
        failureMessage: message,
        vendorGuess,
      };
    }
  };

  const start = () => {
    if (files.length === 0 || running) return;
    const currentOperation = ++operation.current;
    cancelRequested.current = false;
    setEntries([]);
    setCancelled(false);
    setProgress(0);
    setProgressText("Starting local analysis…");
    setRunning(true);

    void (async () => {
      const collected: CorpusRunEntry[] = [];
      for (const [index, file] of files.entries()) {
        if (cancelRequested.current) break;
        setProgressText(`${file.name} · analysing…`);
        const entry = await analyseOne(file);
        if (currentOperation !== operation.current) return;
        collected.push(entry);
        setEntries([...collected]);
        setProgress(((index + 1) / files.length) * 100);
      }
      if (currentOperation !== operation.current) return;
      const wasCancelled = cancelRequested.current;
      setRunning(false);
      setCancelled(wasCancelled);
      setProgress(wasCancelled ? 0 : 100);
      setProgressText(
        wasCancelled ? "Analysis cancelled." : "Corpus analysis complete.",
      );
    })();
  };

  const cancel = () => {
    cancelRequested.current = true;
    setProgressText("Cancellation requested; finishing the current safe step…");
  };

  const reset = () => {
    operation.current++;
    cancelRequested.current = false;
    setFiles([]);
    setEntries([]);
    setRunning(false);
    setProgress(0);
    setProgressText("");
    setCancelled(false);
  };

  const summary = summarizeRun(entries);

  return (
    <Stack className={s.root} gap="md">
      <Group gap="xs">
        <IconBinary />
        <div>
          <Title order={3}>Local firmware corpus runner</Title>
          <Text size="sm" c="dimmed">
            Batch-measure extraction, HII navigation and Hide/Show availability.
          </Text>
        </div>
      </Group>
      <Alert color="blue" title="Local-only by design">
        Firmware files stay in this browser. Exported reports contain filenames, SHA-256
        hashes, structural metrics and diagnostic reasons, but no firmware bytes.
      </Alert>
      <FileInput
        leftSection={<IconUpload />}
        size="lg"
        multiple
        clearable
        placeholder="Select multiple BIOS/firmware images"
        value={files}
        disabled={running}
        onChange={(selected) => {
          setFiles(selected);
          setEntries([]);
          setCancelled(false);
        }}
      />
      {files.length > 0 && (
        <Text size="sm">
          {String(files.length)} file(s) selected ·{" "}
          {formatBytes(files.reduce((total, file) => total + file.size, 0))} total
        </Text>
      )}
      <Group>
        <Button
          leftSection={<IconPlayerPlay />}
          disabled={files.length === 0 || running}
          onClick={start}
        >
          Run local corpus analysis
        </Button>
        {running && (
          <Button color="orange" variant="light" leftSection={<IconPlayerStop />} onClick={cancel}>
            Cancel
          </Button>
        )}
        <Button
          variant="default"
          leftSection={<IconTrash />}
          disabled={running || (files.length === 0 && entries.length === 0)}
          onClick={reset}
        >
          Clear
        </Button>
      </Group>
      {(running || progressText) && (
        <Stack gap="xs">
          <Progress value={progress} animated={running} />
          <Text size="sm">{progressText}</Text>
        </Stack>
      )}
      {cancelled && entries.length > 0 && (
        <Alert color="yellow" title="Partial report">
          The run was cancelled. Completed firmware results remain available for export.
        </Alert>
      )}
      {entries.length > 0 && (
        <>
          <SimpleGrid cols={{ base: 2, sm: 4, lg: 8 }} spacing="xs">
            <Metric label="Files" value={summary.files} />
            <Metric label="Unique" value={summary.uniqueFiles} />
            <Metric label="Recognized" value={summary.recognized} />
            <Metric label="Partial" value={summary.partial} />
            <Metric label="Unsupported" value={summary.unsupported} />
            <Metric label="Extraction" value={`${String(summary.extractionRate)}%`} />
            <Metric label="Navigation" value={`${String(summary.navigationRate)}%`} />
            <Metric label="HII editable" value={`${String(summary.hiiEditRate)}%`} />
          </SimpleGrid>
          <Group>
            <Button
              variant="default"
              leftSection={<IconDownload />}
              onClick={() => {
                saveAs(
                  new Blob([JSON.stringify(entries, null, 2)], {
                    type: "application/json",
                  }),
                  "uefi-editor-corpus-report.json",
                );
              }}
            >
              Export JSON report
            </Button>
            <Button
              variant="default"
              leftSection={<IconDownload />}
              onClick={() => {
                saveAs(
                  new Blob([entriesToCsv(entries)], { type: "text/csv" }),
                  "uefi-editor-corpus-report.csv",
                );
              }}
            >
              Export CSV summary
            </Button>
          </Group>
          <Accordion variant="separated" multiple>
            {entries.map((entry, entryIndex) => {
              const totals = entryTotals(entry);
              return (
                <Accordion.Item
                  value={`${entry.sha256 || entry.fileName}:${String(entryIndex)}`}
                  key={`${entry.fileName}:${String(entryIndex)}`}
                >
                  <Accordion.Control>
                    <Group justify="space-between" wrap="nowrap">
                      <div className={s.fileName}>
                        <Text fw={600}>{entry.fileName}</Text>
                        <Text size="xs" c="dimmed">
                          {formatBytes(entry.size)} · {entry.container ?? "unknown"} ·{" "}
                          {generationLabel(entry)} · {String(entry.contextCount)} context(s)
                        </Text>
                      </div>
                      <Group gap="xs" wrap="nowrap">
                        {entry.report && (
                          <Badge variant="light">
                            {String(totals.forms)} forms · {String(totals.refs)} refs
                          </Badge>
                        )}
                        {totals.hide + totals.show > 0 && (
                          <Badge color="blue" variant="light">
                            H {String(totals.hide)} · S {String(totals.show)}
                          </Badge>
                        )}
                        {entry.vendorGuess && (
                          <Badge color="gray" variant="light">
                            {entry.vendorGuess.label}
                          </Badge>
                        )}
                        <Badge color={statusColor(entry.status)}>
                          {corpusStatusLabels[entry.status]}
                        </Badge>
                      </Group>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <FileDetails entry={entry} />
                  </Accordion.Panel>
                </Accordion.Item>
              );
            })}
          </Accordion>
        </>
      )}
    </Stack>
  );
}
