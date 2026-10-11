import { type AmiGenerationAssessment, type AmiSetupLayout, type AmiSetupProfileReport, type FirmwareContainer, type FirmwareVendorFamily, formatHexOffset } from "../scripts/amiFirmwareImage";
import { type FirmwareArtifactCoherence } from "../scripts/firmwareProvenance";
import { type FirmwareSectionCompression } from "../scripts/firmwareSections";
import { type PhoenixSetupItem } from "../scripts/phoenixSetupTable";

// Labels and small pure helpers of the firmware upload screen: detection,
// layout, container and compression names, vendor and Phoenix text.
export const MAX_FIRMWARE_BYTES = 512 * 1024 * 1024;


export function offsets(values: number[]) {
  return values.length === 0 ? "Not found" : values.map(formatHexOffset).join(", ");
}


export function outerModuleOffsets(values: number[]) {
  return values.length === 0
    ? "Not visible before deep scan"
    : values.map(formatHexOffset).join(", ");
}


export function detectionLabel(assessment: AmiGenerationAssessment) {
  if (assessment.conflict) return "AMI Aptio — generation signals conflict";
  if (assessment.generation === "aptio-iv") return "AMI Aptio IV — probable HII profile";
  if (assessment.generation === "aptio-v") return "AMI Aptio V — probable HII profile";
  return "AMI Aptio — generation unresolved";
}


export function layoutLabel(layout: AmiSetupLayout) {
  if (layout === "split-form-packages") return "split legacy profile";
  if (layout === "unified-setup-formset") return "unified Setup profile";
  return "unresolved profile";
}


export function formatProfileValue(value: number) {
  return `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;
}


export function spfLabel(profile: AmiSetupProfileReport) {
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


export function compressionName(compression: FirmwareSectionCompression) {
  if (compression === "lzma") return "LZMA";
  if (compression === "standard") return "EFI/Tiano";
  return "uncompressed wrapper";
}


export function coherenceLabel(coherence: FirmwareArtifactCoherence) {
  if (coherence === "same-firmware-volume") return "same firmware volume";
  if (coherence === "same-decoded-buffer") return "same decoded buffer";
  if (coherence === "shared-encapsulation-branch") return "shared encapsulation branch";
  return "Setup only";
}


export function containerLabel(container: FirmwareContainer) {
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
export const nonAmiVendorFamilies = new Set<FirmwareVendorFamily>([
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


export function vendorSummaryColor(family: FirmwareVendorFamily) {
  if (family === "non-firmware" || family === "intel-me") return "gray";
  if (family === "legacy-framework-hii") return "yellow";
  return "blue";
}


export function phoenixItemTypeLabel(type: PhoenixSetupItem["type"]) {
  if (type === "pick-field") return "Pick Field";
  if (type === "generic-text") return "Text";
  if (type === "information") return "Submenu";
  if (type === "time") return "Time";
  if (type === "date") return "Date";
  if (type === "action") return "Action";
  if (type === "boot-device-slot") return "Boot Device";
  return "Hex";
}


// Phoenix Setup text stores multi-line help as one string with embedded
// \r line breaks (no \n) - collapse them to spaces for a one-line table
// cell rather than showing the raw control characters.
export function phoenixText(value: string | null) {
  return value === null ? null : value.replace(/\r/g, " ").trim();
}


// A Generic Text / Information item reads as an in-line group label rather
// than a regular question - confirmed against several real records (e.g.
// "Exit", "Main", "Security") that name the section or a sub-group within
// it; see docs/phoenix/README.md. This never claims a full, confirmed
// screen title - only that this particular row reads as a label - so it's
// a bold row, not a synthesized section name.
export function isPhoenixLabelItem(type: PhoenixSetupItem["type"]) {
  return type === "generic-text" || type === "information";
}


// An item this inventory can genuinely make visible: it carries the real,
// disassembly-confirmed visibility-callback hook (see PhoenixVisibilityPatch
// in phoenixSetupTable.ts) and that hook's hide path currently returns a
// non-zero sentinel - an item whose hook is already 0 is already
// unconditionally visible, nothing to force.
export function isForceableItem(item: PhoenixSetupItem) {
  return item.visibilityPatch !== null && item.visibilityPatch.hiddenImmediate !== 0;
}
