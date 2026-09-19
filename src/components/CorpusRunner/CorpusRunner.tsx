import React from "react";
import { Alert, Badge, Button, FileInput, Group, Progress, Stack, Table, Text } from "@mantine/core";
import { IconDownload, IconStack2 } from "@tabler/icons-react";
import { saveAs } from "file-saver";
import {
  inspectAmiFirmwareBytes,
  inspectAmiSetupProfile,
  reconcileAmiGeneration,
} from "../scripts/amiFirmwareImage";
import { extractFirmwareInWorker } from "../scripts/aptioIvExtractorClient";
import { parseData } from "../scripts/ifrParser";
import { buildPopulatedFilesFromArtifacts } from "../scripts/populatedFilesFromArtifacts";
import { buildCorpusReport, type CorpusReport } from "../scripts/corpusReport";

const MAX_FIRMWARE_BYTES = 512 * 1024 * 1024;

interface CorpusRunEntry {
  label: string;
  status: "running" | "done" | "failed";
  report?: CorpusReport;
  error?: string;
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
        const generation = reconcileAmiGeneration(preflight, profile).generation;
        const populated = buildPopulatedFilesFromArtifacts(extracted, file.name, generation);
        const data = await parseData(populated);
        data.firmwareFamily = generation === "unresolved" ? "ami-aptio" : generation;
        const report = buildCorpusReport(data, file.name);
        result = { label: file.name, status: "done", report };
      } catch (error) {
        result = {
          label: file.name,
          status: "failed",
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
          <Table striped withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>File</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Navigation</Table.Th>
                <Table.Th>Direct / suppressed tabs</Table.Th>
                <Table.Th>Hide blocked</Table.Th>
                <Table.Th>Show blocked</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {entries.map((entry) => {
                const report = entry.report;
                const hideBlocked = report?.tabOperations.filter(
                  (op) => op.role === "direct-tab" && !op.hide.available,
                ).length;
                const showBlocked = report?.tabOperations.filter(
                  (op) => op.role === "suppressed-tab" && !op.show.available,
                ).length;
                return (
                  <Table.Tr key={entry.label}>
                    <Table.Td>{entry.label}</Table.Td>
                    <Table.Td>
                      <Badge
                        variant="light"
                        color={
                          entry.status === "done"
                            ? "green"
                            : entry.status === "failed"
                              ? "red"
                              : "blue"
                        }
                      >
                        {entry.status === "running" ? "analysing…" : entry.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{report?.navigation.status ?? (entry.error ?? "—")}</Table.Td>
                    <Table.Td>
                      {report
                        ? `${String(report.navigation.directTabs)} / ${String(report.navigation.suppressedTabs)}`
                        : "—"}
                    </Table.Td>
                    <Table.Td>{hideBlocked ?? "—"}</Table.Td>
                    <Table.Td>{showBlocked ?? "—"}</Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
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
          {entries.some((entry) => entry.status === "failed") && (
            <Alert color="orange" title="Some images could not be analysed">
              {entries
                .filter((entry) => entry.status === "failed")
                .map((entry) => `${entry.label}: ${entry.error ?? "unknown error"}`)
                .join(" · ")}
            </Alert>
          )}
        </Stack>
      )}
    </Stack>
  );
}
