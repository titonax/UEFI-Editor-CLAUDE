import React from "react";
import { Alert, FileInput, Group, Progress, Stack, Table, Text } from "@mantine/core";
import { IconBinary, IconUpload } from "@tabler/icons-react";
import {
  formatHexOffset,
  inspectAptioIvImage,
  type AptioIvImageReport,
} from "../scripts/aptioIvImage";
import type { AptioIvArtifacts } from "../scripts/aptioIvExtractor";
import type { AptioIvExtractorWorkerResult } from "../scripts/aptioIvExtractorWorker";
import type { PopulatedFiles } from "../FileUploads/FileUploads";

function offsets(values: number[]) {
  return values.length === 0 ? "Not found" : values.map(formatHexOffset).join(", ");
}

interface BiosImageUploadProps {
  onExtracted: (files: PopulatedFiles) => Promise<void>;
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Recursive nested-volume decompression + IFRExtractor both run as
// synchronous WASM inside this worker, so a genuinely pathological or
// deeply-nested image can run for a long time - or, if it hits a bug,
// effectively forever. Running it off the main thread means the UI stays
// responsive and a timeout can actually terminate it (a main-thread
// setTimeout can't preempt a synchronous computation that never yields).
const EXTRACTION_TIMEOUT_MS = 90_000;

function extractInWorker(file: File): Promise<AptioIvArtifacts> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("../scripts/aptioIvExtractorWorker.ts", import.meta.url),
      { type: "module" },
    );
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(
        new Error(
          `Extraction timed out after ${String(EXTRACTION_TIMEOUT_MS / 1000)}s. This image may be too deeply nested/compressed to process automatically - try the four-file expert mode below instead (extract Setup HII/SCT, the IFR Extractor TXT, AMITSE PE32, and SetupData BIN yourself, e.g. with UEFITool + IFRExtractor-RS).`,
        ),
      );
    }, EXTRACTION_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<AptioIvExtractorWorkerResult>) => {
      clearTimeout(timeout);
      worker.terminate();
      if (event.data.ok) {
        resolve(event.data.artifacts);
      } else {
        reject(new Error(event.data.error));
      }
    };
    worker.onerror = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message || "The extraction worker crashed."));
    };
    worker.postMessage(file);
  });
}

export default function BiosImageUpload({ onExtracted }: BiosImageUploadProps) {
  const [file, setFile] = React.useState<File | null>(null);
  const [report, setReport] = React.useState<AptioIvImageReport | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [stage, setStage] = React.useState("");
  const [error, setError] = React.useState("");

  return (
    <Stack>
      <Group gap="xs">
        <IconBinary />
        <Text fw={700}>Full Aptio IV image</Text>
      </Group>
      <FileInput
        leftSection={<IconUpload />}
        size="lg"
        placeholder="Complete BIOS image (.bin/.rom/.u1l)"
        accept=".bin,.rom,.u1l"
        value={file}
        disabled={loading}
        onChange={(selected) => {
          setFile(selected);
          setReport(null);
          setError("");
          if (selected) {
            setLoading(true);
            setStage("Inspecting firmware volumes…");
            void inspectAptioIvImage(selected)
              .then(async (imageReport) => {
                setReport(imageReport);
                if (
                  !imageReport.aptioIvCandidate &&
                  !imageReport.deepScanRequired
                ) {
                  return;
                }
                setStage("Decompressing nested volumes and locating Setup…");
                const artifacts = await extractInWorker(selected);
                setStage("Decoding IFR and building the menu tree…");
                const setupFile = new File([artifacts.hii], "setup-aptio-iv.bin");
                const ifrFile = new File([artifacts.ifrText], "setup-aptio-iv.ifr.txt", {
                  type: "text/plain",
                });
                const amitseBytes = artifacts.amitse ?? new Uint8Array();
                const setupDataBytes =
                  artifacts.setupData ?? new Uint8Array();
                const amitseFile = new File(
                  [amitseBytes],
                  "amitse-aptio-iv.bin",
                );
                const setupDataFile = new File(
                  [setupDataBytes],
                  "setupdata-aptio-iv.bin",
                );
                await onExtracted({
                  setupSctContainer: {
                    file: setupFile,
                    textContent: toHex(artifacts.hii),
                    isWrongFile: false,
                  },
                  setupTxtContainer: {
                    file: ifrFile,
                    textContent: artifacts.ifrText,
                    isWrongFile: false,
                  },
                  amitseSctContainer: {
                    file: amitseFile,
                    textContent: toHex(amitseBytes),
                    isWrongFile: false,
                  },
                  setupdataBinContainer: {
                    file: setupDataFile,
                    textContent: toHex(setupDataBytes),
                    isWrongFile: false,
                  },
                });
              })
              .catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : String(reason));
              })
              .finally(() => {
                setLoading(false);
                setStage("");
              });
          }
        }}
      />
      {loading && (
        <Stack gap="xs">
          <Progress value={100} animated />
          <Text size="sm">{stage}</Text>
        </Stack>
      )}
      {error && <Alert color="red" title="Aptio IV extraction failed">{error}</Alert>}
      {report && (
        <>
          <Alert
            color={
              report.aptioIvCandidate
                ? "green"
                : report.deepScanRequired
                  ? "blue"
                  : "yellow"
            }
          >
            {report.aptioIvCandidate
              ? report.nestedFirmwareCandidate
                ? "AMI Aptio IV candidate: Setup is inside a compressed nested volume. Recursive extraction is required."
                : "AMI Aptio IV candidate: Setup FFS was found. Automatic IFR extraction is available."
              : report.deepScanRequired
                ? "UEFI image recognized: Setup is not directly visible. Recursive decompression and module discovery will be attempted."
                : "No valid UEFI firmware volumes were found. No changes can be generated for this image."}
          </Alert>
          <Table striped withColumnBorders>
            <Table.Tbody>
              <Table.Tr><Table.Th>Image size</Table.Th><Table.Td>{report.size.toLocaleString()} bytes</Table.Td></Table.Tr>
              <Table.Tr><Table.Th>Intel descriptor</Table.Th><Table.Td>{report.intelDescriptor ? "Present" : "Not detected"}</Table.Td></Table.Tr>
              <Table.Tr><Table.Th>Firmware volumes</Table.Th><Table.Td>{offsets(report.firmwareVolumes)}</Table.Td></Table.Tr>
              <Table.Tr><Table.Th>Setup FFS</Table.Th><Table.Td>{offsets(report.setupFfs)}</Table.Td></Table.Tr>
              <Table.Tr><Table.Th>AMITSE FFS</Table.Th><Table.Td>{offsets(report.amitseFfs)}</Table.Td></Table.Tr>
            </Table.Tbody>
          </Table>
        </>
      )}
    </Stack>
  );
}
