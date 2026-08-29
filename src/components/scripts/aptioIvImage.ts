export interface AptioIvImageReport {
  size: number;
  intelDescriptor: boolean;
  firmwareVolumes: number[];
  setupFfs: number[];
  amitseFfs: number[];
  nestedFirmwareCandidate: boolean;
  deepScanRequired: boolean;
  aptioIvCandidate: boolean;
}

const setupFfsGuid = "D7079489FE99D8439A2179EC328CAC21";
const amitseFfsGuid = "DF0ADAB1774F7040A88EBFFE1C60529A";
const firmwareVolumeSignature = "5F465648";
const intelDescriptorSignature = "5AA5F00F";
const amitseSetupName = "414D495453455365747570";

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) =>
    byte.toString(16).toUpperCase().padStart(2, "0"),
  ).join("");
}

function findAll(hex: string, signature: string, alignment = 1) {
  const offsets: number[] = [];
  let index = hex.indexOf(signature);

  while (index !== -1) {
    const byteOffset = index / 2;
    if (byteOffset % alignment === 0) {
      offsets.push(byteOffset);
    }
    index = hex.indexOf(signature, index + 2);
  }

  return offsets;
}

function uint16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint64AsNumber(bytes: Uint8Array, offset: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = view.getBigUint64(offset, true);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0;
}

function isValidFirmwareVolume(bytes: Uint8Array, start: number) {
  if (start < 0 || start + 0x38 > bytes.length || start % 8 !== 0) {
    return false;
  }

  const volumeLength = uint64AsNumber(bytes, start + 0x20);
  const headerLength = uint16(bytes, start + 0x30);
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
    checksum = (checksum + uint16(bytes, start + offset)) & 0xffff;
  }

  return checksum === 0;
}

export async function inspectAptioIvImage(
  file: File,
): Promise<AptioIvImageReport> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hex = bytesToHex(bytes);
  const firmwareVolumes = findAll(hex, firmwareVolumeSignature)
    .filter((offset) => offset >= 0x28)
    .map((offset) => offset - 0x28)
    .filter((offset) => isValidFirmwareVolume(bytes, offset));
  const setupFfs = findAll(hex, setupFfsGuid, 8);
  const amitseFfs = findAll(hex, amitseFfsGuid, 8);
  const hasAmiNvramMarkers = hex.includes(amitseSetupName);
  const nestedFirmwareCandidate =
    firmwareVolumes.length !== 0 &&
    setupFfs.length === 0 &&
    amitseFfs.length === 0 &&
    hasAmiNvramMarkers;
  const deepScanRequired =
    firmwareVolumes.length !== 0 && setupFfs.length === 0;
  const intelDescriptor =
    bytes.length >= 0x14 &&
    bytesToHex(bytes.slice(0x10, 0x14)) === intelDescriptorSignature;

  return {
    size: bytes.length,
    intelDescriptor,
    firmwareVolumes,
    setupFfs,
    amitseFfs,
    nestedFirmwareCandidate,
    deepScanRequired,
    aptioIvCandidate:
      firmwareVolumes.length !== 0 &&
      (setupFfs.length !== 0 || hasAmiNvramMarkers),
  };
}

export function formatHexOffset(offset: number) {
  return `0x${offset.toString(16).toUpperCase().padStart(6, "0")}`;
}
