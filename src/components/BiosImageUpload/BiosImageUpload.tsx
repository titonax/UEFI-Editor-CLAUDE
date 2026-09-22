import React from "react";
import {
  Alert,
  Badge,
  Button,
  FileInput,
  Group,
  List,
  NativeSelect,
  NavLink,
  Progress,
  ScrollArea,
  Select,
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
  type FirmwareVendorFamily,
  type FirmwareVendorGuess,
} from "../scripts/amiFirmwareImage";
import type { AptioIvArtifacts } from "../scripts/aptioIvExtractor";
import { extractFirmwareInWorker } from "../scripts/aptioIvExtractorClient";
import {
  assessFirmwareReconstruction,
  type FirmwareArtifactCoherence,
} from "../scripts/firmwareProvenance";
import type { FirmwareSectionCompression } from "../scripts/firmwareSections";
import { buildPopulatedFilesFromArtifacts } from "../scripts/populatedFilesFromArtifacts";
import { inspectPhoenixSetupMenu } from "../scripts/phoenixSetupMenu";
import type { PhoenixSetupItem, PhoenixSetupMenu } from "../scripts/phoenixSetupTable";
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

function coherenceLabel(coherence: FirmwareArtifactCoherence) {
  if (coherence === "same-firmware-volume") return "same firmware volume";
  if (coherence === "same-decoded-buffer") return "same decoded buffer";
  if (coherence === "shared-encapsulation-branch") return "shared encapsulation branch";
  return "Setup only";
}

function containerLabel(container: FirmwareContainer) {
  if (container === "intel-flash") return "Complete Intel flash";
  if (container === "firmware-volume-image") return "Raw firmware volume image";
  if (container === "vendor-image") return "Vendor update image";
  if (container === "phoenix-rom") return "Phoenix modular ROM";
  return "Unknown container";
}

// Families with unambiguous, structurally-understood evidence against AMI
// Aptio: no point running the AMI-only deep extraction (it can only end in
// "Setup FFS was not found") or showing the AMI generation/Setup-profile
// panel for one of these. "uefi-generic" and "unknown" stay in the AMI flow
// below - firmware volumes with no top-level vendor marker at all is exactly
// the case where Setup/AMITSE might still be hidden behind encapsulation, so
// the deep scan is still worth attempting.
const nonAmiVendorFamilies = new Set<FirmwareVendorFamily>([
  "award",
  "phoenix",
  "phoenix-uefi",
  "insyde",
  "ami-legacy",
  "embedded-non-bios",
  "legacy-framework-hii",
  "intel-me",
  "non-firmware",
]);

function vendorSummaryColor(family: FirmwareVendorFamily) {
  if (family === "non-firmware" || family === "intel-me") return "gray";
  if (family === "legacy-framework-hii") return "yellow";
  return "blue";
}

// The non-AMI counterpart to the AMI generation/Setup-profile panel below:
// this editor only ever parses/edits AMI Aptio HII, so a definitively
// non-AMI image gets its vendor guess and outer-container evidence instead
// of AMI-specific fields (Setup FFS, AMITSE FFS, $SPF, HII Forms layout)
// that were never going to be found in it.
function VendorSummary({
  report,
  vendorGuess,
}: {
  report: AmiFirmwareImageReport;
  vendorGuess: FirmwareVendorGuess;
}) {
  return (
    <>
      <Alert color={vendorSummaryColor(vendorGuess.family)} title={vendorGuess.label}>
        This editor only parses and edits AMI Aptio HII. This image was identified as{" "}
        {vendorGuess.label} from its own byte signatures - nothing below is parsed any
        further.
      </Alert>
      <Group gap="xs">
        <Badge variant="light">{containerLabel(report.container)}</Badge>
      </Group>
      {vendorGuess.evidence.length > 0 && (
        <Text size="xs" c="dimmed">
          Evidence: {vendorGuess.evidence.join(", ")}
        </Text>
      )}
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
        </Table.Tbody>
      </Table>
    </>
  );
}

function phoenixItemTypeLabel(type: PhoenixSetupItem["type"]) {
  if (type === "pick-field") return "Pick Field";
  if (type === "generic-text") return "Text";
  if (type === "information") return "Submenu";
  if (type === "time") return "Time";
  if (type === "date") return "Date";
  return "Hex";
}

// Phoenix Setup text stores multi-line help as one string with embedded
// \r line breaks (no \n) - collapse them to spaces for a one-line table
// cell rather than showing the raw control characters.
function phoenixText(value: string | null) {
  return value === null ? null : value.replace(/\r/g, " ").trim();
}

// A Generic Text / Information item reads as an in-line group label rather
// than a regular question - confirmed against several real records (e.g.
// "Exit", "Main", "Security") that name the section or a sub-group within
// it; see docs/phoenix/README.md. This never claims a full, confirmed
// screen title - only that this particular row reads as a label - so it's
// a bold row, not a synthesized section name.
function isPhoenixLabelItem(type: PhoenixSetupItem["type"]) {
  return type === "generic-text" || type === "information";
}

// The Phoenix counterpart to the AMI Aptio HII menu tree: every screen a
// legacy Phoenix CMOS Setup Table defines, with each item's prompt/help
// resolved from STRINGS.ROM and a Pick Field's own option list turned into
// a real selector. Laid out the same way the AMI editor is - a screen list
// on the left, the selected screen's items on the right - though unlike
// the AMI tree this never claims a confirmed hierarchy between screens
// (see docs/phoenix/README.md). A Pick Field's selection here is staged in
// this browser tab only: there is no LH5 encoder available yet to
// recompress an edited TEMPLAT.ROM back into a flashable image, so nothing
// selected below is written anywhere - see docs/phoenix/README.md.
function PhoenixSetupMenuPanel({ menu }: { menu: PhoenixSetupMenu }) {
  const sections = React.useMemo(
    () => menu.sections.filter((section) => section.items.length > 0),
    [menu],
  );
  const [selectedOffset, setSelectedOffset] = React.useState<number | null>(
    sections[0]?.offset ?? null,
  );
  const [selections, setSelections] = React.useState<Record<number, string>>({});

  const totalItems = sections.reduce((sum, section) => sum + section.items.length, 0);
  if (totalItems === 0) return null;
  const selectedSection = sections.find((section) => section.offset === selectedOffset) ?? sections[0];

  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Badge variant="light" color="grape">
          Phoenix Setup menu: {String(sections.length)} screen(s), {String(totalItems)} item(s)
        </Badge>
      </Group>
      <Text size="xs" c="dimmed">
        Prompts, help text and a Pick Field's own option list, all resolved
        from STRINGS.ROM. Bold rows are Text/Submenu items, which read as
        in-line group labels rather than questions. This never confirms a
        hierarchy between screens, and a selection made below is only kept
        in this browser tab - it isn't written back into the image yet, and
        some items may be conditionally hidden on real hardware by embedded
        firmware logic this inventory can't evaluate - see
        docs/phoenix/README.md.
      </Text>
      <Group align="flex-start" gap="md" wrap="nowrap">
        <ScrollArea.Autosize mah={480} miw={220} maw={220}>
          <Stack gap={2}>
            {sections.map((section, index) => (
              <NavLink
                key={section.offset}
                label={`Screen ${String(index + 1)}`}
                description={`${String(section.items.length)} item(s)`}
                active={section.offset === selectedSection.offset}
                onClick={() => {
                  setSelectedOffset(section.offset);
                }}
                variant="light"
              />
            ))}
          </Stack>
        </ScrollArea.Autosize>
        <ScrollArea.Autosize mah={480} style={{ flex: 1, minWidth: 0 }}>
          <Table striped withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Type</Table.Th>
                <Table.Th>Prompt</Table.Th>
                <Table.Th>Help</Table.Th>
                <Table.Th>Options</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {selectedSection.items.map((item) => {
                const isLabel = isPhoenixLabelItem(item.type);
                // Mantine's Select rejects duplicate option values outright
                // (throws, taking down the whole panel) - two option slots
                // can resolve to the same text, so de-duplicate defensively.
                const options = Array.from(
                  new Set(item.options.map((option) => phoenixText(option) ?? option)),
                );
                return (
                  <Table.Tr key={item.offset}>
                    <Table.Td>{phoenixItemTypeLabel(item.type)}</Table.Td>
                    <Table.Td fw={isLabel ? 700 : undefined}>
                      {phoenixText(item.prompt) ?? "—"}
                    </Table.Td>
                    <Table.Td>{phoenixText(item.help)}</Table.Td>
                    <Table.Td>
                      {options.length > 0 && (
                        <Select
                          size="xs"
                          data={options}
                          value={selections[item.offset] ?? options[0]}
                          onChange={(value) => {
                            if (value === null) return;
                            setSelections((current) => ({ ...current, [item.offset]: value }));
                          }}
                          allowDeselect={false}
                          comboboxProps={{ withinPortal: false }}
                        />
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      </Group>
    </Stack>
  );
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
  const artifactCache = React.useRef(new Map<string, AptioIvArtifacts>());
  const [file, setFile] = React.useState<File | null>(null);
  const [report, setReport] = React.useState<AmiFirmwareImageReport | null>(null);
  const [phoenixMenu, setPhoenixMenu] = React.useState<PhoenixSetupMenu | null>(null);
  const [artifacts, setArtifacts] = React.useState<AptioIvArtifacts | null>(null);
  const [profile, setProfile] = React.useState<AmiSetupProfileReport | null>(null);
  const [selectedArtifactSetId, setSelectedArtifactSetId] = React.useState<string | null>(
    null,
  );
  const [loading, setLoading] = React.useState(false);
  const [stage, setStage] = React.useState("");
  const [error, setError] = React.useState("");

  const inspectFirmware = async (selected: File | null) => {
    const currentOperation = ++operation.current;
    setFile(selected);
    setReport(null);
    setPhoenixMenu(null);
    setArtifacts(null);
    setProfile(null);
    setSelectedArtifactSetId(null);
    artifactCache.current.clear();
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

      // A Phoenix legacy CMOS Setup Table (STRINGS0.ROM/TEMPLAT0.ROM) can
      // exist in an image with no AMI Aptio evidence at all - even one
      // with no visible firmware volumes, since a legacy Phoenix ROM never
      // used the UEFI PI volume format to begin with (see
      // docs/phoenix/README.md). Skipped for an actual AMI Aptio candidate,
      // which is never also a Phoenix image.
      if (!imageReport.amiAptioCandidate) {
        setStage("Looking for a Phoenix Setup Table…");
        const menu = await inspectPhoenixSetupMenu(image);
        if (currentOperation !== operation.current) return;
        setPhoenixMenu(menu);
        // A real Setup Table is itself Phoenix evidence, every bit as good
        // as inspectPhoenixLegacyBytes's own BCPSYS/BCPFFV-anchored find -
        // it's the same inventoryPhoenixLegacyBytes couldn't reach here for
        // lack of a BCP/FFV directory (see phoenixSetupMenu.ts's standalone
        // module-name fallback). Folding it into vendorGuess/container keeps
        // VendorSummary's own family check the single source of truth
        // instead of adding a second "is this vendor evidence" predicate to
        // the render path below.
        if (menu?.sections.some((section) => section.items.length > 0)) {
          setReport((current) =>
            current?.vendorGuess.family === "unknown"
              ? {
                  ...current,
                  container: "phoenix-rom",
                  vendorGuess: {
                    family: "phoenix",
                    label: "PhoenixBIOS 4.0",
                    evidence: ["Legacy CMOS Setup Table (TEMPLAT.ROM/STRINGS.ROM)"],
                  },
                }
              : current,
          );
        }
      }

      if (imageReport.firmwareVolumes.length === 0) return;
      // A definitively non-AMI vendor (its own byte signature already says
      // so) can only ever fail the AMI-only deep extraction with "Setup FFS
      // was not found" - skip the wasted decompression pass and the
      // misleading "analysis failed" it would otherwise show.
      if (nonAmiVendorFamilies.has(imageReport.vendorGuess.family)) return;

      setStage("Decompressing nested volumes and locating AMI Setup data…");
      const extracted = await extractFirmwareInWorker(selected);
      if (currentOperation !== operation.current) return;

      setStage("Inspecting $SPF and the HII Forms layout…");
      setArtifacts(extracted);
      setProfile(inspectAmiSetupProfile(extracted.hii, extracted.setupData));
      artifactCache.current.set(extracted.selectedArtifactSetId, extracted);
      // A single coherent context is picked automatically; more than one
      // requires an explicit choice before "Start HII analysis" unlocks,
      // since Setup/AMITSE/SetupData must never be mixed across slots.
      setSelectedArtifactSetId(
        extracted.artifactSets.length === 1 ? extracted.selectedArtifactSetId : null,
      );
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

  const selectArtifactSet = async (artifactSetId: string | null) => {
    if (!artifactSetId || !file) return;
    if (artifacts?.selectedArtifactSetId === artifactSetId) {
      setSelectedArtifactSetId(artifactSetId);
      return;
    }
    const currentOperation = operation.current;
    setLoading(true);
    setError("");
    try {
      setStage("Loading the selected firmware context…");
      const cached = artifactCache.current.get(artifactSetId);
      const extracted = cached ?? (await extractFirmwareInWorker(file, { artifactSetId }));
      if (currentOperation !== operation.current) return;
      artifactCache.current.set(artifactSetId, extracted);
      setArtifacts(extracted);
      setProfile(inspectAmiSetupProfile(extracted.hii, extracted.setupData));
      setSelectedArtifactSetId(artifactSetId);
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
    if (!artifacts || !selectedArtifactSetId) return;
    const currentOperation = operation.current;
    setLoading(true);
    setError("");
    try {
      setStage("Decoding IFR and building the menu tree…");
      await onExtracted(
        buildPopulatedFilesFromArtifacts(
          artifacts,
          file?.name ?? "firmware.bin",
          report ? reconcileAmiGeneration(report, profile).generation : "unresolved",
        ),
      );
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
  const selectedArtifactSet = artifacts?.artifactSets.find(
    (candidate) => candidate.id === artifacts.selectedArtifactSetId,
  );

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
          {nonAmiVendorFamilies.has(report.vendorGuess.family) ? (
            <VendorSummary report={report} vendorGuess={report.vendorGuess} />
          ) : (
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
                  <Table.Tr>
                    <Table.Th>Firmware contexts</Table.Th>
                    <Table.Td>
                      {String(artifacts.artifactSets.length)} coherent Setup set
                      {artifacts.artifactSets.length === 1 ? "" : "s"}
                    </Table.Td>
                  </Table.Tr>
                  {selectedArtifactSet && (
                    <Table.Tr>
                      <Table.Th>Previewed context</Table.Th>
                      <Table.Td>
                        {selectedArtifactSet.label} ·{" "}
                        {coherenceLabel(selectedArtifactSet.coherence)}
                      </Table.Td>
                    </Table.Tr>
                  )}
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
          {artifacts && artifacts.artifactSets.length > 1 && (
            <Alert color="orange" title="Multiple firmware contexts detected">
              <Stack gap="xs">
                <Text size="sm">
                  This image contains repeated AMI Setup modules in separate decoded
                  buffers or firmware volumes. Choose the context to analyse; Setup,
                  AMITSE and SetupData will never be mixed across equally plausible
                  slots.
                </Text>
                <NativeSelect
                  label="Firmware context / slot"
                  data={[
                    { value: "", label: "Choose one context", disabled: true },
                    ...artifacts.artifactSets.map((candidate) => ({
                      value: candidate.id,
                      label: candidate.label,
                    })),
                  ]}
                  value={selectedArtifactSetId ?? ""}
                  disabled={loading}
                  onChange={(event) =>
                    void selectArtifactSet(event.currentTarget.value || null)
                  }
                />
              </Stack>
            </Alert>
          )}
          {selectedArtifactSet && selectedArtifactSet.warnings.length > 0 && (
            <Alert color="yellow" title="Firmware context caveats">
              <List size="sm" spacing="xs">
                {selectedArtifactSet.warnings.map((warning) => (
                  <List.Item key={warning}>{warning}</List.Item>
                ))}
              </List>
            </Alert>
          )}
          <Button
            size="lg"
            leftSection={<IconPlayerPlay />}
            disabled={
              loading || !artifacts || !profile || selectedArtifactSetId === null
            }
            onClick={() => void startAnalysis()}
          >
            Start HII analysis
          </Button>
        </>
        )}
        {report.phoenixLegacy && (
          <Alert color="grape" title="Phoenix 4.0 module inventory">
            <Stack gap="xs">
              <Text size="sm">
                {report.phoenixLegacy.format === "phoenix-ffv" ? "BCP/FFV directory" : "BCPSYS module chain"}{" "}
                · build {report.phoenixLegacy.buildCode || "?"} ·{" "}
                {report.phoenixLegacy.buildDate || "?"} ·{" "}
                {String(report.phoenixLegacy.modules.length)} module(s). This is a
                read-only inventory (offsets, sizes, compression) - Phoenix menu
                editing is not available; see docs/phoenix/README.md.
              </Text>
              {report.phoenixLegacy.warnings.map((warning) => (
                <Text size="xs" c="orange" key={warning}>
                  {warning}
                </Text>
              ))}
              {report.phoenixLegacy.modules.length > 0 && (
                <Table striped withColumnBorders>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Module</Table.Th>
                      <Table.Th>Offset</Table.Th>
                      <Table.Th>Size</Table.Th>
                      <Table.Th>Compression</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {report.phoenixLegacy.modules.map((module, index) => (
                      <Table.Tr key={`${module.name}:${String(index)}`}>
                        <Table.Td>{module.name}</Table.Td>
                        <Table.Td>0x{module.offset.toString(16).toUpperCase()}</Table.Td>
                        <Table.Td>{module.size}</Table.Td>
                        <Table.Td>{module.compression}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Stack>
          </Alert>
        )}
        {report.phoenixUefi && (
          <Alert color="grape" title="Phoenix UEFI module provenance">
            <Text size="sm">
              Debug-path module name(s): {report.phoenixUefi.debugModules.join(", ")}.
              This is module provenance, not a Setup-format verdict - a Phoenix PDB
              path never overrides this image's own vendor detection above; see
              docs/phoenix/README.md.
            </Text>
          </Alert>
        )}
        {phoenixMenu && <PhoenixSetupMenuPanel menu={phoenixMenu} />}
        </>
      )}
    </Stack>
  );
}
