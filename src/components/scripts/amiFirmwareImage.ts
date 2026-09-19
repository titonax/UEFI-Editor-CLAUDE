import { scanHiiFormsPackages } from "./hiiPackages";

export type AmiFirmwareGeneration = "aptio-iv" | "aptio-v" | "unresolved";
export type DetectionConfidence = "confirmed" | "probable" | "unresolved";
export type FirmwareContainer =
  | "intel-flash"
  | "firmware-volume-image"
  | "vendor-image"
  | "unknown";

export interface FirmwareEvidence {
  code: string;
  summary: string;
  detail: string;
  supports: "uefi" | "ami-aptio" | "aptio-iv" | "aptio-v" | "container";
  strength: "strong" | "supporting" | "context";
}

// A coarse best-effort guess at what this image actually is when it isn't
// an AMI Aptio candidate: this editor only ever parses/edits AMI Aptio, but
// a real-world corpus mixes in Award/Phoenix-Award, Phoenix, Insyde, other
// unbranded UEFI, and firmware that was never a PC BIOS at all (a router or
// monitor dump). Naming which of those a rejected image looks like is far
// more useful than a blanket "unsupported", even though none of them are
// ever parsed further than this signature scan.
export type FirmwareVendorFamily =
  | "ami-aptio"
  | "award"
  | "phoenix"
  | "insyde"
  | "uefi-generic"
  | "embedded-non-bios"
  | "legacy-framework-hii"
  | "unknown";

export interface FirmwareVendorGuess {
  family: FirmwareVendorFamily;
  label: string;
  evidence: string[];
}

// Not a byte-signature guess: IFRExtractor-RS itself reports its "Extraction
// mode" as UEFI or Framework once it has actually decoded the HII, and
// ifrParser.ts rejects the latter outright (this editor only ever speaks PI/
// UEFI HII). A real corpus still carries pre-UEFI2.0 machines (seen on an
// early-2010s ultrabook) whose Setup module is genuine EFI 1.10 "Framework"
// HII - correctly out of scope, not a bug, so it gets the same
// "Unsupported" + guess treatment as an unrecognized vendor rather than a
// blanket "Failed". sniffNonAmiFailure below is what a caller checks first.
export const legacyFrameworkHiiGuess: FirmwareVendorGuess = {
  family: "legacy-framework-hii",
  label: 'Legacy EFI 1.10 "Framework" HII (pre-UEFI2.0, not supported)',
  evidence: [],
};

// What a shallow, read-only pass over the raw image bytes can tell before
// anything is decompressed: which structures are visible at the top level,
// and what (if anything) that says about the AMI generation.
export interface AmiFirmwareImageReport {
  size: number;
  container: FirmwareContainer;
  intelDescriptor: boolean;
  firmwareVolumes: number[];
  ffs2Volumes: number[];
  ffs3Volumes: number[];
  setupFfs: number[];
  amitseFfs: number[];
  guidedLzmaSections: number[];
  setupDataProfiles: number[];
  nestedFirmwareCandidate: boolean;
  deepScanRequired: boolean;
  amiAptioCandidate: boolean;
  vendorGuess: FirmwareVendorGuess;
  generation: AmiFirmwareGeneration;
  confidence: DetectionConfidence;
  evidence: FirmwareEvidence[];
}

export type AmiSetupLayout =
  | "split-form-packages"
  | "unified-setup-formset"
  | "unresolved";

// What the extracted Setup HII and SetupData say about the layout, once the
// deep scan has actually produced them.
export interface AmiSetupProfileReport {
  spfPresent: boolean;
  spfField04: number | null;
  spfField08: number | null;
  formPackageCount: number;
  formSetGuids: string[];
  layout: AmiSetupLayout;
  generation: AmiFirmwareGeneration;
  confidence: DetectionConfidence;
  evidence: FirmwareEvidence[];
}

export interface AmiGenerationAssessment {
  generation: AmiFirmwareGeneration;
  confidence: DetectionConfidence;
  conflict: boolean;
}

function ascii(value: string) {
  return new TextEncoder().encode(value);
}

function hexBytes(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

interface Signature {
  name: string;
  bytes: Uint8Array;
  alignment?: number;
  insensitiveAscii?: boolean;
}

// Byte patterns worth locating in the raw image. FFS file GUIDs are always
// 8-byte aligned inside a volume, which rules out chance matches in
// compressed payloads.
const signatures: Signature[] = [
  { name: "firmwareVolume", bytes: ascii("_FVH") },
  { name: "setupFfs", bytes: hexBytes("D7079489FE99D8439A2179EC328CAC21"), alignment: 8 },
  { name: "amitseFfs", bytes: hexBytes("DF0ADAB1774F7040A88EBFFE1C60529A"), alignment: 8 },
  { name: "guidedLzma", bytes: hexBytes("98584EEE143959429D6EDC7BD79403CF") },
  { name: "setupDataGuid", bytes: hexBytes("722B61FE3C20B1478560A66D946EB371") },
  { name: "amitseSetup", bytes: ascii("AMITSESetup") },
  { name: "nvar", bytes: ascii("NVAR") },
  { name: "setupDataProfile", bytes: ascii("$SPF") },
  { name: "americanMegatrends", bytes: ascii("American Megatrends"), insensitiveAscii: true },
  { name: "aptioIv", bytes: ascii("Aptio IV"), insensitiveAscii: true },
  { name: "aptio4", bytes: ascii("Aptio 4"), insensitiveAscii: true },
  { name: "aptioV", bytes: ascii("Aptio V"), insensitiveAscii: true },
  { name: "aptio5", bytes: ascii("Aptio 5"), insensitiveAscii: true },
  // Non-AMI PC BIOS vendors: never parsed further, but naming them beats a
  // blanket "unsupported" (see FirmwareVendorGuess below).
  { name: "awardSoftware", bytes: ascii("Award Software"), insensitiveAscii: true },
  { name: "awardBios", bytes: ascii("AwardBIOS"), insensitiveAscii: true },
  { name: "phoenixAward", bytes: ascii("Phoenix - AwardBIOS"), insensitiveAscii: true },
  { name: "phoenixTechnologies", bytes: ascii("Phoenix Technologies"), insensitiveAscii: true },
  { name: "phoenixBios", bytes: ascii("PhoenixBIOS"), insensitiveAscii: true },
  { name: "insydeCorp", bytes: ascii("Insyde Corp"), insensitiveAscii: true },
  { name: "insydeH2o", bytes: ascii("InsydeH2O"), insensitiveAscii: true },
  // Not a PC BIOS at all: an embedded-Linux blob (router/IoT/appliance).
  { name: "uBoot", bytes: ascii("U-Boot") },
  { name: "openWrt", bytes: ascii("OpenWrt"), insensitiveAscii: true },
  { name: "squashFsMagic", bytes: ascii("hsqs") },
  { name: "linuxVersion", bytes: ascii("Linux version") },
];

const ffs2Guid = hexBytes("78E58C8C3D8A1C4F9935896185C32DD3");
const ffs3Guid = hexBytes("7AC07354CB3DCA4DBD6F1E9689E7349A");
const intelDescriptorSignature = hexBytes("5AA5F00F");
const spfSignature = ascii("$SPF");
const unifiedAmiSetupFormSetGuid = "7B59104A-C00D-4158-87FF-F04D6396A915";

function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function u32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    true,
  );
}

function u64(bytes: Uint8Array, offset: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = view.getBigUint64(offset, true);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0;
}

function bytesEqual(
  bytes: Uint8Array,
  offset: number,
  expected: Uint8Array,
  insensitiveAscii = false,
) {
  if (offset < 0 || offset + expected.length > bytes.length) return false;
  for (let index = 0; index < expected.length; index++) {
    const actual = bytes[offset + index];
    const wanted = expected[index];
    if (actual === wanted) continue;
    const isLetter = actual >= 0x41 && actual <= 0x7a;
    if (!insensitiveAscii || !isLetter || (actual | 0x20) !== (wanted | 0x20)) {
      return false;
    }
  }
  return true;
}

// One pass over the image, dispatching on the first byte so each position
// only compares against the handful of signatures that could start there.
function scanSignatures(bytes: Uint8Array) {
  const results = new Map<string, number[]>(
    signatures.map((signature) => [signature.name, []]),
  );
  const byFirstByte = new Map<number, Signature[]>();
  for (const signature of signatures) {
    const first = signature.bytes[0];
    const keys = signature.insensitiveAscii ? [first & ~0x20, first | 0x20] : [first];
    for (const key of new Set(keys)) {
      byFirstByte.set(key, [...(byFirstByte.get(key) ?? []), signature]);
    }
  }

  for (let offset = 0; offset < bytes.length; offset++) {
    const candidates = byFirstByte.get(bytes[offset]);
    if (!candidates) continue;
    for (const signature of candidates) {
      if (
        offset % (signature.alignment ?? 1) === 0 &&
        bytesEqual(bytes, offset, signature.bytes, signature.insensitiveAscii)
      ) {
        results.get(signature.name)?.push(offset);
      }
    }
  }
  return results;
}

function isValidFirmwareVolume(bytes: Uint8Array, start: number) {
  if (start < 0 || start + 0x38 > bytes.length || start % 8 !== 0) {
    return false;
  }

  const volumeLength = u64(bytes, start + 0x20);
  const headerLength = u16(bytes, start + 0x30);
  if (
    headerLength < 0x38 ||
    headerLength % 2 !== 0 ||
    volumeLength < headerLength ||
    start + volumeLength > bytes.length
  ) {
    return false;
  }

  let checksum = 0;
  for (let offset = 0; offset < headerLength; offset += 2) {
    checksum = (checksum + u16(bytes, start + offset)) & 0xffff;
  }

  return checksum === 0;
}

// The LZMA custom-decompress GUID on its own is just 16 bytes; it only
// counts as a GUID-Defined Section when a plausible section header (either
// size) precedes it and the section's own DataOffset/size are consistent.
function guidedSectionStart(bytes: Uint8Array, guidOffset: number) {
  for (const headerSize of [4, 8] as const) {
    const start = guidOffset - headerSize;
    if (start < 0 || start + headerSize + 20 > bytes.length) continue;
    const size24 = u24(bytes, start);
    const extended = size24 === 0xffffff;
    if (bytes[start + 3] !== 0x02 || extended !== (headerSize === 8)) continue;
    const size = extended ? u32(bytes, start + 4) : size24;
    const dataOffset = u16(bytes, guidOffset + 16);
    if (
      size >= headerSize + 20 &&
      dataOffset >= headerSize + 20 &&
      dataOffset <= size &&
      start + size <= bytes.length
    ) {
      return start;
    }
  }
  return null;
}

function containerOf(
  firmwareVolumes: number[],
  intelDescriptor: boolean,
): FirmwareContainer {
  if (intelDescriptor) return "intel-flash";
  if (firmwareVolumes.includes(0)) return "firmware-volume-image";
  if (firmwareVolumes.length > 0) return "vendor-image";
  return "unknown";
}

const vendorSignatureLabels: Record<string, string> = {
  awardSoftware: "Award Software",
  awardBios: "AwardBIOS",
  phoenixAward: "Phoenix - AwardBIOS",
  phoenixTechnologies: "Phoenix Technologies",
  phoenixBios: "PhoenixBIOS",
  insydeCorp: "Insyde Corp.",
  insydeH2o: "InsydeH2O",
  uBoot: "U-Boot",
  openWrt: "OpenWrt",
  squashFsMagic: "SquashFS magic",
  linuxVersion: "Linux version string",
};

// Runs only once none of this editor's own AMI Aptio evidence matched -
// what does the rest of the corpus's non-AMI signature evidence say this
// image actually is? Award/Phoenix-Award, Phoenix and Insyde are checked
// ahead of "some other UEFI" because their own strings are strong, specific
// evidence; an embedded-Linux marker (router/IoT firmware, never a PC BIOS)
// is checked before falling back to a bare "has firmware volumes" guess.
function classifyFirmwareVendor(
  has: (...names: string[]) => boolean,
  amiAptioCandidate: boolean,
  firmwareVolumeCount: number,
): FirmwareVendorGuess {
  const matched = (...names: string[]) => names.filter((name) => has(name));
  const labelled = (names: string[]) => names.map((name) => vendorSignatureLabels[name]);

  if (amiAptioCandidate) {
    return { family: "ami-aptio", label: "AMI Aptio", evidence: [] };
  }
  const award = matched("awardSoftware", "awardBios", "phoenixAward");
  if (award.length > 0) {
    return { family: "award", label: "Award / Phoenix-Award BIOS", evidence: labelled(award) };
  }
  const phoenix = matched("phoenixTechnologies", "phoenixBios");
  if (phoenix.length > 0) {
    return { family: "phoenix", label: "Phoenix BIOS", evidence: labelled(phoenix) };
  }
  const insyde = matched("insydeCorp", "insydeH2o");
  if (insyde.length > 0) {
    return { family: "insyde", label: "Insyde H2O", evidence: labelled(insyde) };
  }
  const embedded = matched("uBoot", "openWrt", "squashFsMagic", "linuxVersion");
  if (embedded.length > 0) {
    return {
      family: "embedded-non-bios",
      label: "Embedded Linux firmware (router/IoT, not a PC BIOS)",
      evidence: labelled(embedded),
    };
  }
  if (firmwareVolumeCount > 0) {
    return {
      family: "uefi-generic",
      label: "Generic/unbranded UEFI (no AMI Aptio Setup found)",
      evidence: [],
    };
  }
  return { family: "unknown", label: "Unrecognized firmware", evidence: [] };
}

export function inspectAmiFirmwareBytes(bytes: Uint8Array): AmiFirmwareImageReport {
  const found = scanSignatures(bytes);
  const offsets = (name: string) => found.get(name) ?? [];
  const has = (...names: string[]) => names.some((name) => offsets(name).length > 0);

  const firmwareVolumes = offsets("firmwareVolume")
    .map((offset) => offset - 0x28)
    .filter((offset) => isValidFirmwareVolume(bytes, offset));
  const setupFfs = offsets("setupFfs");
  const amitseFfs = offsets("amitseFfs");
  const guidedLzmaSections = offsets("guidedLzma").flatMap((offset) => {
    const start = guidedSectionStart(bytes, offset);
    return start === null ? [] : [start];
  });
  const setupDataProfiles = offsets("setupDataProfile");
  const ffs2Volumes = firmwareVolumes.filter((offset) =>
    bytesEqual(bytes, offset + 0x10, ffs2Guid),
  );
  const ffs3Volumes = firmwareVolumes.filter((offset) =>
    bytesEqual(bytes, offset + 0x10, ffs3Guid),
  );
  const intelDescriptor = bytesEqual(bytes, 0x10, intelDescriptorSignature);
  const explicitIv = has("aptioIv", "aptio4");
  const explicitV = has("aptioV", "aptio5");
  const hasAmiMarkers = has(
    "amitseSetup",
    "americanMegatrends",
    "setupDataGuid",
    "setupDataProfile",
  );
  const amiAptioCandidate =
    firmwareVolumes.length > 0 &&
    (hasAmiMarkers ||
      setupFfs.length > 0 ||
      amitseFfs.length > 0 ||
      explicitIv ||
      explicitV);
  const vendorGuess = classifyFirmwareVendor(has, amiAptioCandidate, firmwareVolumes.length);

  // An explicit generation string is only trusted when exactly one
  // generation is named; naming both says nothing.
  const generation: AmiFirmwareGeneration =
    explicitIv === explicitV ? "unresolved" : explicitIv ? "aptio-iv" : "aptio-v";
  const confidence: DetectionConfidence =
    generation === "unresolved" ? "unresolved" : "probable";

  const evidence: FirmwareEvidence[] = [];
  if (firmwareVolumes.length > 0) {
    evidence.push({
      code: "valid-fv",
      summary: `${String(firmwareVolumes.length)} valid firmware volume(s)`,
      detail: "UEFI PI firmware volumes passed bounds and header-checksum validation.",
      supports: "uefi",
      strength: "strong",
    });
  }
  if (intelDescriptor) {
    evidence.push({
      code: "intel-descriptor",
      summary: "Intel flash descriptor",
      detail: "The input appears to be a complete Intel SPI flash image.",
      supports: "container",
      strength: "strong",
    });
  }
  if (has("amitseSetup")) {
    evidence.push({
      code: "amitse-setup",
      summary: "AMITSESetup NVRAM marker",
      detail: "This supports the AMI Aptio family, but is shared by Aptio IV and V.",
      supports: "ami-aptio",
      strength: "strong",
    });
  }
  if (setupFfs.length > 0 || amitseFfs.length > 0) {
    evidence.push({
      code: "classic-ami-modules",
      summary: "AMI Setup/AMITSE module GUIDs",
      detail:
        "Classic AMI module identities were found; the attached Aptio V corpus proves that these GUIDs are not generation-specific.",
      supports: "ami-aptio",
      strength: "strong",
    });
  }
  if (guidedLzmaSections.length > 0) {
    evidence.push({
      code: "guided-lzma",
      summary: `${String(guidedLzmaSections.length)} LZMA GUID-defined section(s)`,
      detail:
        "Encapsulated firmware may contain Setup and AMITSE; Start HII analysis resolves these nested layers.",
      supports: "uefi",
      strength: "strong",
    });
  }
  if (has("americanMegatrends")) {
    evidence.push({
      code: "ami-vendor-string",
      summary: "American Megatrends vendor string",
      detail: "Uncompressed AMI vendor metadata is present.",
      supports: "ami-aptio",
      strength: "supporting",
    });
  }
  if (ffs3Volumes.length > 0) {
    evidence.push({
      code: "ffs3",
      summary: `${String(ffs3Volumes.length)} FFS3 volume(s)`,
      detail: "FFS3 is a PI format capability and is not proof of Aptio V.",
      supports: "uefi",
      strength: "context",
    });
  }
  if (explicitIv || explicitV) {
    const conflicting = explicitIv && explicitV;
    evidence.push({
      code: "explicit-generation",
      summary: conflicting
        ? "Conflicting Aptio generation strings"
        : `Explicit ${explicitIv ? "Aptio IV/4" : "Aptio V/5"} metadata`,
      detail: conflicting
        ? "Both generations are named, so the image cannot be classified from strings alone."
        : "An explicit generation string was found in the image.",
      supports: conflicting ? "ami-aptio" : explicitIv ? "aptio-iv" : "aptio-v",
      strength: "strong",
    });
  }
  if (setupDataProfiles.length > 0) {
    evidence.push({
      code: "spf-profile",
      summary: "$SPF SetupData profile",
      detail:
        "This is strong AMI SetupData evidence, but the same $SPF revision is used by the attached Aptio IV and V corpora.",
      supports: "ami-aptio",
      strength: "strong",
    });
  }

  return {
    size: bytes.length,
    container: containerOf(firmwareVolumes, intelDescriptor),
    intelDescriptor,
    firmwareVolumes,
    ffs2Volumes,
    ffs3Volumes,
    setupFfs,
    amitseFfs,
    guidedLzmaSections,
    setupDataProfiles,
    nestedFirmwareCandidate:
      firmwareVolumes.length > 0 && setupFfs.length === 0 && hasAmiMarkers,
    // Setup and AMITSE can each independently be hidden behind encapsulation
    // (see firmwareSections.ts): a deep scan is needed whenever either is
    // missing from this shallow pass, not only when Setup is.
    deepScanRequired:
      firmwareVolumes.length > 0 && (setupFfs.length === 0 || amitseFfs.length === 0),
    amiAptioCandidate,
    vendorGuess,
    generation,
    confidence,
    evidence,
  };
}

export async function inspectAmiFirmwareImage(
  file: File,
): Promise<AmiFirmwareImageReport> {
  return inspectAmiFirmwareBytes(new Uint8Array(await file.arrayBuffer()));
}

function formatHexValue(value: number, width: number) {
  return `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
}

// Classifies the extracted Setup layout. Corpus experience: a single Forms
// Package using AMI's shared "unified Setup" FormSet GUID goes with Aptio V,
// while several split packages (each its own FormSet) go with Aptio IV -
// both are profile matches, not vendor declarations, hence never
// "confirmed".
export function inspectAmiSetupProfile(
  hii: Uint8Array,
  setupData?: Uint8Array,
): AmiSetupProfileReport {
  const packages = scanHiiFormsPackages(hii);
  const formSetGuids = [...new Set(packages.flatMap((pkg) => pkg.formSetGuids))];
  const isUnifiedGuid = (candidate: string) =>
    candidate.toLowerCase() === unifiedAmiSetupFormSetGuid.toLowerCase();

  const spfPresent = setupData !== undefined && bytesEqual(setupData, 0, spfSignature);
  const spfField04 = spfPresent && setupData.length >= 8 ? u32(setupData, 4) : null;
  const spfField08 = spfPresent && setupData.length >= 12 ? u32(setupData, 8) : null;

  const unifiedSetup =
    packages.length === 1 && formSetGuids.length === 1 && isUnifiedGuid(formSetGuids[0]);
  const splitSetup = packages.length > 1 && !formSetGuids.some(isUnifiedGuid);
  const layout: AmiSetupLayout = unifiedSetup
    ? "unified-setup-formset"
    : splitSetup
      ? "split-form-packages"
      : "unresolved";
  const generation: AmiFirmwareGeneration = unifiedSetup
    ? "aptio-v"
    : splitSetup
      ? "aptio-iv"
      : "unresolved";

  const evidence: FirmwareEvidence[] = [];
  if (spfPresent) {
    const spfFields = [
      spfField04 === null ? null : `field +0x04 ${formatHexValue(spfField04, 4)}`,
      spfField08 === null ? null : `field +0x08 ${formatHexValue(spfField08, 4)}`,
    ].filter((value): value is string => value !== null);
    evidence.push({
      code: "spf-profile",
      summary: "$SPF SetupData profile",
      detail: `$SPF confirms the AMI SetupData schema${spfFields.length === 0 ? "" : ` (${spfFields.join(", ")})`}, but it is shared by Aptio IV and V. The field meanings are deliberately not inferred without a published specification.`,
      supports: "ami-aptio",
      strength: "strong",
    });
  }
  if (splitSetup) {
    evidence.push({
      code: "split-form-packages",
      summary: `${String(packages.length)} split HII Forms Packages`,
      detail:
        "The attached cross-vendor corpus consistently associates this legacy multi-FormSet layout with Aptio IV.",
      supports: "aptio-iv",
      strength: "supporting",
    });
  } else if (unifiedSetup) {
    evidence.push({
      code: "unified-setup-formset",
      summary: "Unified AMI Setup FormSet",
      detail:
        "One HII Forms Package uses the shared AMI Setup FormSet GUID; the attached corpus consistently associates this layout with Aptio V.",
      supports: "aptio-v",
      strength: "supporting",
    });
  } else if (packages.length > 0) {
    evidence.push({
      code: "hii-form-packages",
      summary: `${String(packages.length)} valid HII Forms Package(s)`,
      detail:
        "The HII layout is valid but does not match a generation profile strongly enough to classify it.",
      supports: "ami-aptio",
      strength: "context",
    });
  }

  return {
    spfPresent,
    spfField04,
    spfField08,
    formPackageCount: packages.length,
    formSetGuids,
    layout,
    generation,
    confidence: generation === "unresolved" ? "unresolved" : "probable",
    evidence,
  };
}

// The deep Setup profile wins over the outer byte scan when it has an
// opinion; two different opinions are reported as a conflict rather than
// silently picking either.
export function reconcileAmiGeneration(
  outer: Pick<AmiFirmwareImageReport, "generation" | "confidence">,
  setupProfile?: Pick<AmiSetupProfileReport, "generation" | "confidence"> | null,
): AmiGenerationAssessment {
  const generations = new Set(
    [outer.generation, setupProfile?.generation].filter(
      (value): value is AmiFirmwareGeneration =>
        value !== undefined && value !== "unresolved",
    ),
  );
  if (generations.size > 1) {
    return { generation: "unresolved", confidence: "unresolved", conflict: true };
  }
  if (setupProfile && setupProfile.generation !== "unresolved") {
    return {
      generation: setupProfile.generation,
      confidence: setupProfile.confidence,
      conflict: false,
    };
  }
  return { generation: outer.generation, confidence: outer.confidence, conflict: false };
}

export function formatHexOffset(offset: number) {
  return `0x${offset.toString(16).toUpperCase().padStart(6, "0")}`;
}

// extractAptioIvBytes throws the first two once it has walked every
// firmware volume and encapsulation layer without ever finding an AMI Setup
// module; ifrParser.ts's parseData throws the third once IFRExtractor-RS
// reports the decoded HII as legacy Framework rather than UEFI (see
// legacyFrameworkHiiGuess above). All three are structurally-understood
// "this just isn't (usable) AMI Aptio", not a bug or a corrupt image. A
// corpus runner uses this to label such a failure "unsupported" (with its
// best vendorGuess attached - legacyFrameworkHiiGuess for the third,
// otherwise the preflight's byte-signature vendorGuess) instead of a
// blanket "failed", which is reserved for genuinely unexpected errors.
const knownNonAmiExtractionFailures = [
  "Setup FFS was not found after recursive decompression.",
  "No Setup context contains a usable HII package or Setup PE32 section.",
  "Only UEFI is supported.",
];

export function sniffNonAmiFailure(message: string): boolean {
  return knownNonAmiExtractionFailures.some((known) => message.includes(known));
}
