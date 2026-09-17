import React from "react";
import {
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
import { IconBinary, IconPlayerPlay, IconUpload } from "@tabler/icons-react";
import {
  formatHexOffset,
  inspectAmiFirmwareBytes,
  inspectAmiSetupProfile,
  reconcileAmiGeneration,
  type AmiFirmwareImageReport,
  type AmiGenerationAssessment,
  type AmiSetupLayout,
  type AmiSetupProfileReport,
  type FirmwareContainer,
} from "../scripts/amiFirmwareImage";
import type { AptioIvArtifacts } from "../scripts/aptioIvExtractor";
import { extractFirmwareInWorker } from "../scripts/aptioIvExtractorClient";
import { assessFirmwareReconstruction } from "../scripts/firmwareProvenance";
import type { FirmwareSectionCompression } from "../scripts/firmwareSections";
import type { PopulatedFiles } from "../FileUploads/fileModel";

const MAX_FIRMWARE_BYTES = 512 * 1024 * 1024;

function offsets(values: number[]) {
  return values.length === 0 ? "Not found" : values.map(formatHexOffset).join(", ");
}

function outerModuleOffsets(values: number[]) {
  return values.length === 0
    ? "Not visible before deep scan"
    : values.map(formatHexOffset).join(", ");
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) =>
    byte.toString(16).toUpperCase().padStart(2, "0"),
  ).join("");
}

function detectionLabel(assessment: AmiGenerationAssessment) {
  if (assessment.conflict) return "AMI Aptio — generation signals conflict";
  if (assessment.generation === "aptio-iv") return "AMI Aptio IV — probable HII profile";
  if (assessment.generation === "aptio-v") return "AMI Aptio V — probable HII profile";
  return "AMI Aptio — generation unresolved";
}

function layoutLabel(layout: AmiSetupLayout) {
  if (layout === "split-form-packages") return "split legacy profile";
  if (layout === "unified-setup-formset") return "unified Setup profile";
  return "unresolved profile";
}

function formatProfileValue(value: number) {
  return `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function spfLabel(profile: AmiSetupProfileReport) {
  if (!profile.spfPresent) return "Not found";
  const fields = [
    profile.spfField04 === null
      ? null
      : `field +0x04 ${formatProfileValue(profile.spfField04)}`,
    profile.spfField08 === null
      ? null
      : `field +0x08 ${formatProfileValue(profile.spfField08)}`,
  ].filter((value): value is string => value !== null);
  return fields.length === 0 ? "Found" : `Found · ${fields.join(" · ")}`;
}

function compressionName(compression: FirmwareSectionCompression) {
  if (compression === "lzma") return "LZMA";
  if (compression === "standard") return "EFI/Tiano";
  return "uncompressed wrapper";
}

function containerLabel(container: FirmwareContainer) {
  if (container === "intel-flash") return "Complete Intel flash";
  if (container === "firmware-volume-image") return "Raw firmware volume image";
  if (container === "vendor-image") return "Vendor update image";
  return "Unknown container";
}

interface BiosImageUploadProps {
  onExtracted: (files: PopulatedFiles) => Promise<void>;
}

// Two-phase flow: picking an image immediately runs the read-only
// preflight (byte scan, deep extraction, Setup profile) and shows what was
// found; only an explicit "Start HII analysis" hands the already-extracted
// artifacts over to the editor. Picking another image mid-way bumps the
// operation counter so a stale preflight can't overwrite a newer one.
export default function BiosImageUpload({ onExtracted }: BiosImageUploadProps) {
  const operation = React.useRef(0);
  const [file, setFile] = React.useState<File | null>(null);
  const [report, setReport] = React.useState<AmiFirmwareImageReport | null>(null);
  const [artifacts, setArtifacts] = React.useState<AptioIvArtifacts | null>(null);
  const [profile, setProfile] = React.useState<AmiSetupProfileReport | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [stage, setStage] = React.useState("");
  const [error, setError] = React.useState("");

  const inspectFirmware = async (selected: File | null) => {
    const currentOperation = ++operation.current;
    setFile(selected);
    setReport(null);
    setArtifacts(null);
    setProfile(null);
    setError("");
    if (!selected) return;
    if (selected.size > MAX_FIRMWARE_BYTES) {
      setError("The selected firmware exceeds the 512 MiB safety limit.");
      return;
    }

    setLoading(true);
    try {
      setStage("Reading the firmware locally…");
      const image = new Uint8Array(await selected.arrayBuffer());
      if (currentOperation !== operation.current) return;

      setStage("Validating firmware volumes and the outer container…");
      const imageReport = inspectAmiFirmwareBytes(image);
      setReport(imageReport);
      if (imageReport.firmwareVolumes.length === 0) return;

      setStage("Decompressing nested volumes and locating AMI Setup data…");
      const extracted = await extractFirmwareInWorker(selected);
      if (currentOperation !== operation.current) return;

      setStage("Inspecting $SPF and the HII Forms layout…");
      setArtifacts(extracted);
      setProfile(inspectAmiSetupProfile(extracted.hii, extracted.setupData));
    } catch (reason: unknown) {
      if (currentOperation === operation.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (currentOperation === operation.current) {
        setLoading(false);
        setStage("");
      }
    }
  };

  const startAnalysis = async () => {
    if (!artifacts) return;
    const currentOperation = operation.current;
    setLoading(true);
    setError("");
    try {
      setStage("Decoding IFR and building the menu tree…");
      const amitseBytes = artifacts.amitse ?? new Uint8Array();
      const setupDataBytes = artifacts.setupData ?? new Uint8Array();
      await onExtracted({
        setupSctContainer: {
          file: new File([artifacts.hii], "setup-ami-aptio.bin"),
          textContent: toHex(artifacts.hii),
          isWrongFile: false,
        },
        setupTxtContainer: {
          file: new File([artifacts.ifrText], "setup-ami-aptio.ifr.txt", {
            type: "text/plain",
          }),
          textContent: artifacts.ifrText,
          isWrongFile: false,
        },
        amitseSctContainer: {
          file: new File([amitseBytes], "amitse-ami-aptio.bin"),
          textContent: toHex(amitseBytes),
          isWrongFile: false,
        },
        setupdataBinContainer: {
          file: new File([setupDataBytes], "setupdata-ami-aptio.bin"),
          textContent: toHex(setupDataBytes),
          isWrongFile: false,
        },
        firmwareSource: {
          fileName: file?.name ?? "firmware.bin",
          artifacts,
          generation: report
            ? reconcileAmiGeneration(report, profile).generation
            : "unresolved",
        },
      });
    } catch (reason: unknown) {
      if (currentOperation === operation.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (currentOperation === operation.current) {
        setLoading(false);
        setStage("");
      }
    }
  };

  const assessment: AmiGenerationAssessment = report
    ? reconcileAmiGeneration(report, profile)
    : { generation: "unresolved", confidence: "unresolved", conflict: false };
  // The deep profile's $SPF entry supersedes the outer scan's, since it
  // also carries the decoded fields.
  const evidence = report
    ? [
        ...report.evidence.filter(
          (entry) => entry.code !== "spf-profile" || !profile?.spfPresent,
        ),
        ...(profile?.evidence ?? []),
      ]
    : [];
  const reconstruction = artifacts
    ? assessFirmwareReconstruction(artifacts.provenance)
    : null;

  return (
    <Stack>
      <Group gap="xs">
        <IconBinary />
        <Text fw={700}>Complete AMI UEFI image</Text>
      </Group>
      <FileInput
        leftSection={<IconUpload />}
        size="lg"
        placeholder="Complete BIOS/firmware image (any filename extension)"
        value={file}
        disabled={loading}
        onChange={(selected) => void inspectFirmware(selected)}
      />
      <Text size="xs" c="dimmed">
        Local-only analysis: the firmware stays in this browser and is never uploaded.
      </Text>
      {loading && (
        <Stack gap="xs">
          <Progress value={100} animated />
          <Text size="sm">{stage}</Text>
        </Stack>
      )}
      {error && (
        <Alert color="red" title="Firmware analysis failed">
          {error}
        </Alert>
      )}
      {report && (
        <>
          <Alert
            color={
              report.amiAptioCandidate
                ? "green"
                : report.firmwareVolumes.length > 0
                  ? "blue"
                  : "yellow"
            }
            title={detectionLabel(assessment)}
          >
            {assessment.conflict
              ? "Outer metadata and the extracted HII layout disagree. The application will not force a generation."
              : profile
                ? assessment.generation === "unresolved"
                  ? "AMI Aptio structures were found, but the shared IV/V layout does not justify forcing a generation."
                  : "The generation is a corpus-backed profile match, not a vendor declaration. It does not unlock a generation-specific write path."
                : report.amiAptioCandidate
                  ? "AMI Aptio evidence was found. The local deep scan is needed before assigning a probable generation."
                  : report.firmwareVolumes.length > 0
                    ? "A valid UEFI image was found, but AMI Aptio evidence is still insufficient. Deep analysis can continue safely."
                    : "No valid UEFI firmware volumes were found. HII analysis is unavailable for this input."}
          </Alert>
          <Group gap="xs">
            <Badge variant="light">{containerLabel(report.container)}</Badge>
            <Badge
              variant="light"
              color={
                assessment.confidence === "confirmed"
                  ? "green"
                  : assessment.confidence === "probable"
                    ? "blue"
                    : "gray"
              }
            >
              {assessment.confidence} confidence
            </Badge>
            {assessment.conflict && (
              <Badge variant="light" color="orange">
                conflicting evidence
              </Badge>
            )}
            {artifacts && <Badge variant="light">local deep scan complete</Badge>}
            {reconstruction && (
              <Badge
                variant="light"
                color={reconstruction.traceComplete ? "gray" : "orange"}
              >
                {reconstruction.traceComplete
                  ? "reconstruction provenance captured"
                  : "incomplete reconstruction provenance"}
              </Badge>
            )}
          </Group>
          <Table striped withColumnBorders>
            <Table.Tbody>
              <Table.Tr>
                <Table.Th>Image size</Table.Th>
                <Table.Td>{report.size.toLocaleString()} bytes</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>Intel descriptor</Table.Th>
                <Table.Td>{report.intelDescriptor ? "Present" : "Not detected"}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>Firmware volumes</Table.Th>
                <Table.Td>{offsets(report.firmwareVolumes)}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>FFS2 / FFS3 volumes</Table.Th>
                <Table.Td>
                  {String(report.ffs2Volumes.length)} /{" "}
                  {String(report.ffs3Volumes.length)}
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>Setup FFS (outer image)</Table.Th>
                <Table.Td>{outerModuleOffsets(report.setupFfs)}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>AMITSE FFS (outer image)</Table.Th>
                <Table.Td>{outerModuleOffsets(report.amitseFfs)}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>LZMA GUID-defined sections</Table.Th>
                <Table.Td>{offsets(report.guidedLzmaSections)}</Table.Td>
              </Table.Tr>
              {artifacts && profile && (
                <>
                  <Table.Tr>
                    <Table.Th>Extracted AMI modules</Table.Th>
                    <Table.Td>
                      Setup HII ({artifacts.hii.length.toLocaleString()} bytes) · AMITSE{" "}
                      {artifacts.amitse ? "found" : "not found"} · SetupData{" "}
                      {artifacts.setupData ? "found" : "not found"}
                    </Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>$SPF SetupData</Table.Th>
                    <Table.Td>{spfLabel(profile)}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>HII Forms layout</Table.Th>
                    <Table.Td>
                      {String(profile.formPackageCount)} package(s) ·{" "}
                      {String(profile.formSetGuids.length)} FormSet GUID(s) ·{" "}
                      {layoutLabel(profile.layout)}
                    </Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>Extraction depth</Table.Th>
                    <Table.Td>
                      {artifacts.extractionDepth === 0
                        ? "Outer firmware volume"
                        : `${String(artifacts.extractionDepth)} nested layer(s)`}
                    </Table.Td>
                  </Table.Tr>
                  {reconstruction && (
                    <Table.Tr>
                      <Table.Th>Reconstruction trace</Table.Th>
                      <Table.Td>
                        {reconstruction.traceComplete ? "Complete" : "Incomplete"}
                        {reconstruction.compressions.length > 0
                          ? ` · ${reconstruction.compressions
                              .map(compressionName)
                              .join(" / ")}`
                          : " · no encapsulation"}
                      </Table.Td>
                    </Table.Tr>
                  )}
                </>
              )}
            </Table.Tbody>
          </Table>
          {report.deepScanRequired && !profile && (
            <Alert color="blue" title="Nested firmware requires HII analysis">
              Setup or AMITSE is not visible in the outer byte stream. The local
              preflight is decompressing nested firmware before deciding that a module
              is absent.
            </Alert>
          )}
          {evidence.length > 0 && (
            <List size="sm" spacing="xs">
              {evidence.map((entry) => (
                <List.Item key={entry.code}>
                  <Text span fw={600}>
                    {entry.summary}:{" "}
                  </Text>
                  <Text span c="dimmed">
                    {entry.detail}
                  </Text>
                </List.Item>
              ))}
            </List>
          )}
          {reconstruction && (
            <Alert
              color={reconstruction.traceComplete ? "gray" : "orange"}
              title={
                reconstruction.traceComplete
                  ? "Full-image reconstruction — trace captured"
                  : "Full-image reconstruction — not traceable"
              }
            >
              <Stack gap="xs">
                {reconstruction.traces.map((trace) => (
                  <Text size="sm" key={trace.kind}>
                    {trace.labels.join(" → ")}
                  </Text>
                ))}
                <Text size="xs" c="dimmed">
                  Writing remains disabled: {reconstruction.blockers.join(" ")}
                </Text>
              </Stack>
            </Alert>
          )}
          <Button
            size="lg"
            leftSection={<IconPlayerPlay />}
            disabled={loading || !artifacts || !profile}
            onClick={() => void startAnalysis()}
          >
            Start HII analysis
          </Button>
        </>
      )}
    </Stack>
  );
}
