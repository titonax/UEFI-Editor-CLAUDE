import React from "react";
import CorpusDashboard from "./CorpusDashboard";
import s from "./CorpusRunner.module.css";
import { Accordion, Alert, Badge, Button, FileInput, Group, Progress, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { IconBinary, IconDownload, IconPlayerPlay, IconPlayerStop, IconTrash, IconUpload } from "@tabler/icons-react";
import { saveAs } from "file-saver";
import { inspectAmiFirmwareBytes, inspectAmiSetupProfile, legacyFrameworkHiiGuess, reconcileAmiGeneration, sniffNonAmiFailure } from "../scripts/amiFirmwareImage";
import { classifyBrand, compareBrandNavigation } from "../scripts/brandKnowledge";
import { extractFirmwareInWorker } from "../scripts/aptioIvExtractorClient";
import { assessFirmwareReconstruction } from "../scripts/firmwareProvenance";
import { sha256Hex } from "../scripts/hashing";
import { frameworkIfrInventory, parseData } from "../scripts/ifrParser";
import { buildPopulatedFilesFromArtifacts } from "../scripts/populatedFilesFromArtifacts";
import { buildCorpusReport, reportNavigationDetected } from "../scripts/corpusReport";
import { type CorpusFileStatus, type CorpusRunEntry, type CorpusStageResult, buildCorpusDashboard } from "../scripts/corpusDashboard";
import { classifyEntry } from "../../knowledge/corpusKnowledge";
import { knownCases } from "../../knowledge";
import { MAX_FIRMWARE_BYTES, corpusStatusLabels, entriesToCsv, entryTotals, formatBytes, frameworkInventoryEvidence, generationLabel, knowledgeBadge, statusColor, summarizeRun, volumeCounts } from "./corpusRunnerFormat";
import { FileDetails, Metric } from "./CorpusFileDetails";

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
    // Hoisted so the catch block can still build a Framework IFR inventory
    // (see ifrParser.ts's frameworkIfrInventory) when parseData rejects a
    // legacy Framework Setup module - extraction itself already succeeded
    // by then, so the verbose IFR text is available even though parsing it
    // as UEFI HII is not.
    let extractedIfrText: string | undefined;
    try {
      if (file.size > MAX_FIRMWARE_BYTES) {
        throw new Error("Exceeds the 512 MiB safety limit.");
      }
      const image = new Uint8Array(await file.arrayBuffer());
      sha256 = await sha256Hex(image);

      // Phoenix module inventory / PDB provenance (see phoenixFirmware.ts)
      // is computed by inspectAmiFirmwareBytes itself, independent of AMI
      // success or failure, so it's available from preflight either way.
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
      extractedIfrText = extracted.ifrText;
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

      // A complete trace means an output can be attempted for a plan on this
      // image; whether one plan can be put back is decided by the check on it
      // (fullImageExport.ts), which a corpus run has no plan to run. A broken
      // trace blocks every output.
      const reconstruction = assessFirmwareReconstruction(extracted.provenance);
      stages.push({
        id: "reconstruction",
        // Nothing was rebuilt in this run, so a complete trace is recorded as
        // not run (evidence that an attempt is possible, not that one passed).
        status: reconstruction.writeEnabled ? "not-run" : "blocked",
        detail: reconstruction.writeEnabled
          ? `Not run: every artifact traces back to the image${reconstruction.compressions.length > 0 ? ` through ${reconstruction.compressions.join(" + ")} section(s)` : ""}, so an output can be attempted.`
          : (reconstruction.blockers[0] ?? "No artifact traces back to the source image."),
      });

      const status: CorpusFileStatus = navigationDetected ? "recognized" : "partial";
      const brand = compareBrandNavigation(classifyBrand(file.name, sha256, preflight.brandMarkers), [
        singleFormSetDetected
          ? "single-formset-ifr-hub"
          : rootVisibilityDetected
            ? "multi-formset-root-vector"
            : "unresolved",
      ]);
      return {
        fileName: file.name,
        size: file.size,
        sha256,
        status,
        container: preflight.container,
        generation,
        contextCount: extracted.artifactSets.length,
        volumes: volumeCounts(preflight),
        reconstructionComplete: reconstruction.traceComplete,
        reconstructionBlockers: reconstruction.blockers,
        stages,
        brand,
        report,
        phoenixLegacy: preflight.phoenixLegacy,
        phoenixUefi: preflight.phoenixUefi,
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
          ? {
              ...legacyFrameworkHiiGuess,
              evidence: extractedIfrText
                ? frameworkInventoryEvidence(frameworkIfrInventory(extractedIfrText))
                : legacyFrameworkHiiGuess.evidence,
            }
          : preflight?.vendorGuess
        : undefined;
      return {
        fileName: file.name,
        size: file.size,
        sha256,
        status: knownNonAmi ? "unsupported" : "failed",
        container: preflight?.container,
        contextCount: 0,
        volumes: preflight ? volumeCounts(preflight) : undefined,
        reconstructionBlockers: [],
        stages,
        failureMessage: message,
        vendorGuess,
        // Brand markers come from the same shallow byte scan as vendorGuess,
        // so a manufacturer lead is still worth reporting even when this
        // image was never AMI Aptio (or failed for an unexpected reason).
        brand: preflight ? classifyBrand(file.name, sha256, preflight.brandMarkers) : undefined,
        phoenixLegacy: preflight?.phoenixLegacy,
        phoenixUefi: preflight?.phoenixUefi,
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
          <CorpusDashboard dashboard={buildCorpusDashboard(entries, files.length, knownCases)} />
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
                        {(() => {
                          const badge = knowledgeBadge(classifyEntry(entry, knownCases));
                          return (
                            <Badge color={badge.color} variant="light" title={badge.title}>
                              {badge.label}
                            </Badge>
                          );
                        })()}
                        {entry.vendorGuess && (
                          <Badge color="gray" variant="light">
                            {entry.vendorGuess.label}
                          </Badge>
                        )}
                        {entry.brand?.brand && (
                          <Badge color="indigo" variant="light">
                            {entry.brand.brand}
                          </Badge>
                        )}
                        {(entry.phoenixLegacy ?? entry.phoenixUefi) && (
                          <Badge color="orange" variant="light">
                            Phoenix
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

