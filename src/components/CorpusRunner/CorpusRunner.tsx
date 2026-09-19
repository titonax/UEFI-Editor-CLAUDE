import React from "react";
import {
  Accordion,
  Alert,
  Badge,
  Button,
  FileInput,
  Group,
  List,
  Progress,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { IconDownload, IconStack2 } from "@tabler/icons-react";
import { saveAs } from "file-saver";
import {
  inspectAmiFirmwareBytes,
  inspectAmiSetupProfile,
  reconcileAmiGeneration,
  type AmiGenerationAssessment,
  type FirmwareContainer,
} from "../scripts/amiFirmwareImage";
import { extractFirmwareInWorker } from "../scripts/aptioIvExtractorClient";
import { assessFirmwareReconstruction } from "../scripts/firmwareProvenance";
import { parseData } from "../scripts/ifrParser";
import { buildPopulatedFilesFromArtifacts } from "../scripts/populatedFilesFromArtifacts";
import { buildCorpusReport, type CorpusReport } from "../scripts/corpusReport";

const MAX_FIRMWARE_BYTES = 512 * 1024 * 1024;

interface CorpusRunEntry {
  label: string;
  status: "running" | "done" | "failed";
  sizeBytes?: number;
  container?: FirmwareContainer;
  generation?: AmiGenerationAssessment;
  reconstructionComplete?: boolean;
  reconstructionBlockers?: string[];
  report?: CorpusReport;
  error?: string;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function generationLabel(assessment?: AmiGenerationAssessment) {
  if (!assessment) return "—";
  if (assessment.conflict) return "conflicting";
  if (assessment.generation === "unresolved") return "unresolved";
  return `${assessment.generation} (${assessment.confidence})`;
}

function statusColor(status: CorpusRunEntry["status"]) {
  if (status === "done") return "green";
  if (status === "failed") return "red";
  return "blue";
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
  const [entries, setEntries] = React.useState<CorpusRunEntry[]>([]);
  const [running, setRunning] = React.useState(false);

  const runFiles = async (files: File[]) => {
    const currentOperation = ++operation.current;
    setRunning(true);
    setEntries(files.map((file) => ({ label: file.name, status: "running" })));

    for (const [index, file] of files.entries()) {
      let result: CorpusRunEntry;
      try {
        if (file.size > MAX_FIRMWARE_BYTES) {
          throw new Error("Exceeds the 512 MiB safety limit.");
        }
        const image = new Uint8Array(await file.arrayBuffer());
        const preflight = inspectAmiFirmwareBytes(image);
        if (preflight.firmwareVolumes.length === 0) {
          throw new Error("No valid UEFI firmware volumes were found.");
        }
        const extracted = await extractFirmwareInWorker(file);
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
        const reconstruction = assessFirmwareReconstruction(extracted.provenance);
        result = {
          label: file.name,
          status: "done",
          sizeBytes: file.size,
          container: preflight.container,
          generation,
          reconstructionComplete: reconstruction.traceComplete,
          reconstructionBlockers: reconstruction.blockers,
          report,
        };
      } catch (error) {
        result = {
          label: file.name,
          status: "failed",
          sizeBytes: file.size,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (currentOperation !== operation.current) return;
      setEntries((current) =>
        current.map((entry, entryIndex) => (entryIndex === index ? result : entry)),
      );
    }
    if (currentOperation === operation.current) setRunning(false);
  };

  const reports = entries.flatMap((entry) => (entry.report ? [entry.report] : []));
  const doneCount = entries.filter((entry) => entry.status !== "running").length;

  const downloadReports = () => {
    saveAs(
      new Blob([JSON.stringify(reports, null, 2)], { type: "application/json" }),
      "corpus-report.json",
    );
  };

  return (
    <Stack>
      <Group gap="xs">
        <IconStack2 />
        <Text fw={700}>Local firmware corpus (optional)</Text>
      </Group>
      <FileInput
        multiple
        leftSection={<IconStack2 size={16} />}
        placeholder="Select several firmware images to analyse in a batch"
        disabled={running}
        onChange={(files) => {
          if (files.length > 0) void runFiles(files);
        }}
      />
      <Text size="xs" c="dimmed">
        Diagnostic only: every image is analysed the same read-only way as the single-image
        preflight above, entirely in this browser. Nothing is patched, exported, or uploaded.
      </Text>
      {entries.length > 0 && (
        <Stack gap="xs">
          {running && (
            <Progress
              value={(doneCount / entries.length) * 100}
              animated={doneCount < entries.length}
            />
          )}
          <Accordion variant="separated" multiple>
            {entries.map((entry, entryIndex) => {
              const report = entry.report;
              const hideOps = report?.tabOperations.filter((op) => op.role === "direct-tab");
              const showOps = report?.tabOperations.filter(
                (op) => op.role === "suppressed-tab",
              );
              const hideAvailable = hideOps?.filter((op) => op.hide.available).length;
              const showAvailable = showOps?.filter((op) => op.show.available).length;
              return (
                <Accordion.Item value={`${entry.label}:${String(entryIndex)}`} key={`${entry.label}:${String(entryIndex)}`}>
                  <Accordion.Control>
                    <Group justify="space-between" wrap="nowrap">
                      <Stack gap={0}>
                        <Text fw={600} size="sm">
                          {entry.label}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {entry.sizeBytes !== undefined ? formatBytes(entry.sizeBytes) : "—"}
                          {" · "}
                          {entry.container ?? "—"}
                          {" · "}
                          {generationLabel(entry.generation)}
                        </Text>
                      </Stack>
                      <Group gap="xs" wrap="nowrap">
                        {report && (
                          <Badge variant="light">
                            {String(report.counts.forms)} forms · {String(report.counts.refs)}{" "}
                            refs
                          </Badge>
                        )}
                        {report && (
                          <Badge color="blue" variant="light">
                            {report.navigation.status}
                          </Badge>
                        )}
                        {report && (hideOps?.length ?? 0) + (showOps?.length ?? 0) > 0 && (
                          <Badge color="teal" variant="light">
                            Hide {String(hideAvailable ?? 0)}/{String(hideOps?.length ?? 0)} ·
                            Show {String(showAvailable ?? 0)}/{String(showOps?.length ?? 0)}
                          </Badge>
                        )}
                        {entry.reconstructionComplete !== undefined && (
                          <Badge
                            color={entry.reconstructionComplete ? "gray" : "orange"}
                            variant="light"
                          >
                            reconstruction {entry.reconstructionComplete ? "traced" : "blocked"}
                          </Badge>
                        )}
                        <Badge color={statusColor(entry.status)}>
                          {entry.status === "running" ? "analysing…" : entry.status}
                        </Badge>
                      </Group>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    {entry.error && (
                      <Alert color="red" title="Could not analyse this image">
                        {entry.error}
                      </Alert>
                    )}
                    {report && (
                      <Stack gap="xs">
                        <Text size="sm">
                          <Text span fw={600}>
                            Navigation:{" "}
                          </Text>
                          {report.navigation.mechanism ?? "n/a"}
                          {report.navigation.confidence
                            ? ` (${report.navigation.confidence})`
                            : ""}{" "}
                          - {String(report.navigation.directTabs)} direct /{" "}
                          {String(report.navigation.suppressedTabs)} suppressed /{" "}
                          {String(report.navigation.descendants)} descendant /{" "}
                          {String(report.navigation.registeredOnly)} registered-only
                        </Text>
                        {report.navigation.reason && (
                          <Text size="xs" c="dimmed">
                            {report.navigation.reason}
                          </Text>
                        )}
                        {entry.reconstructionBlockers && entry.reconstructionBlockers.length > 0 && (
                          <List size="xs" spacing={2}>
                            {entry.reconstructionBlockers.map((blocker) => (
                              <List.Item key={blocker}>{blocker}</List.Item>
                            ))}
                          </List>
                        )}
                        {report.tabOperations.length > 0 && (
                          <Table striped withColumnBorders>
                            <Table.Thead>
                              <Table.Tr>
                                <Table.Th>Page</Table.Th>
                                <Table.Th>Role</Table.Th>
                                <Table.Th>Hide</Table.Th>
                                <Table.Th>Show</Table.Th>
                              </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                              {report.tabOperations.map((op) => (
                                <Table.Tr key={`${op.formId}-${op.name}`}>
                                  <Table.Td>{op.name}</Table.Td>
                                  <Table.Td>{op.role}</Table.Td>
                                  <Table.Td>
                                    <Badge
                                      size="xs"
                                      color={op.hide.available ? "green" : "gray"}
                                      variant="light"
                                    >
                                      {op.hide.available ? "available" : "blocked"}
                                    </Badge>
                                  </Table.Td>
                                  <Table.Td>
                                    <Badge
                                      size="xs"
                                      color={op.show.available ? "green" : "gray"}
                                      variant="light"
                                    >
                                      {op.show.available ? "available" : "blocked"}
                                    </Badge>
                                  </Table.Td>
                                </Table.Tr>
                              ))}
                            </Table.Tbody>
                          </Table>
                        )}
                      </Stack>
                    )}
                  </Accordion.Panel>
                </Accordion.Item>
              );
            })}
          </Accordion>
          {reports.length > 0 && (
            <Group>
              <Button
                size="xs"
                variant="default"
                leftSection={<IconDownload size={16} />}
                onClick={downloadReports}
              >
                Download corpus-report.json
              </Button>
            </Group>
          )}
        </Stack>
      )}
    </Stack>
  );
}
