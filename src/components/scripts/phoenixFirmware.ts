// Read-only structural inventory for Phoenix-family firmware. This editor
// only ever parses/edits AMI Aptio HII; nothing here decodes, interprets or
// patches a Phoenix Setup, template or string module - see
// docs/phoenix/README.md for exactly what has and hasn't been verified, and
// against which real samples.

function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function u32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function hex(value: number, width: number) {
  return value.toString(16).toUpperCase().padStart(width, "0");
}

function guid(bytes: Uint8Array, offset: number) {
  return `${hex(u32(bytes, offset), 8)}-${hex(u16(bytes, offset + 4), 4)}-${hex(
    u16(bytes, offset + 6),
    4,
  )}-${hex(bytes[offset + 8], 2)}${hex(bytes[offset + 9], 2)}-${Array.from(
    bytes.slice(offset + 10, offset + 16),
    (byte) => hex(byte, 2),
  ).join("")}`;
}

export interface PhoenixModule {
  name: string;
  kind: "section" | "raw" | "legacy module";
  offset: number;
  size: number;
  compression: "lh5" | "none" | "unknown";
  packedSize?: number;
  unpackedSize?: number;
  // Where the compressed payload itself starts, for a module with
  // packedSize/unpackedSize - lets a caller (see phoenixSetupMenu.ts) slice
  // it out for decompression without redoing the section-header math.
  payloadOffset?: number;
}

export interface PhoenixLegacyInventory {
  format: "phoenix-ffv" | "phoenix-module-chain";
  buildCode: string;
  buildDate: string;
  compressionAlgorithm: number | null;
  directoryOffset: number | null;
  volumeCount: number;
  modules: PhoenixModule[];
  warnings: string[];
}

// A Phoenix PDB debug path is module provenance, not proof that a given
// image's Setup implementation is actually Phoenix's - see
// inspectPhoenixUefiBytes below.
export interface PhoenixUefiInventory {
  secureCore: boolean;
  debugModules: string[];
}

// Single-letter Phoenix FFV/legacy module type codes, as seen in real BCP
// module names (e.g. "_E00" -> "SETUP0.ROM").
const moduleTypeNames: Record<string, string> = {
  A: "ACPI",
  B: "BIOSCOD",
  C: "UPDATE",
  D: "DISPLAY",
  E: "SETUP",
  G: "DECOMPCODE",
  L: "LOGO",
  M: "MISER",
  R: "OPROM",
  S: "STRINGS",
  T: "TEMPLAT",
  X: "ROMEXEC",
};

const ffvVolumeGuid = "FED91FBA-D37B-4EEA-8729-2EF29FB37A78";

function matchesAt(bytes: Uint8Array, offset: number, value: string) {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index++) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function find(bytes: Uint8Array, value: string, start = 0) {
  for (let offset = start; offset + value.length <= bytes.length; offset++) {
    if (bytes[offset] === value.charCodeAt(0) && matchesAt(bytes, offset, value)) {
      return offset;
    }
  }
  return -1;
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

// A BCP (Boot Configuration Parameters?) record is a fixed name followed by
// a 16-bit length field at +8; only trusted once that length is both
// plausible for this record and stays inside the image.
function bcpRecord(bytes: Uint8Array, name: string, minimumLength: number) {
  const offset = find(bytes, name);
  if (offset < 0 || offset + 10 > bytes.length) return -1;
  const length = u16(bytes, offset + 8);
  return length >= minimumLength && offset + length <= bytes.length ? offset : -1;
}

// FFV module names are either the raw stored bytes, or a packed "_<type><NN
// hex>" form (e.g. "_E00") that expands to a human name like "SETUP0.ROM".
function ffvModuleName(bytes: Uint8Array, offset: number) {
  const raw = bytes.subarray(offset + 8, offset + 24);
  const decoded = Array.from(raw, (byte) => (byte === 0xff ? "" : String.fromCharCode(byte)))
    .join("")
    .split("\0")[0];
  const packed = /^_([A-Z])([0-9A-F]{2})$/.exec(decoded);
  if (packed) {
    return `${moduleTypeNames[packed[1]] ?? packed[1]}${String(Number.parseInt(packed[2], 16))}.ROM`;
  }
  return /^[A-Za-z0-9_.-]{1,16}$/.test(decoded) ? decoded : "Unknown FFV module";
}

// Walks one FFV volume's module list. Each module starts with a 0xF8
// marker; bounds are checked before every read, and a module that would
// overrun its volume stops the walk with a warning rather than reading
// past it. A module can itself hold one GUID-defined-style compressed
// section (kind "section"); this only records its packed/unpacked sizes,
// it never decompresses.
function readFfvModules(
  bytes: Uint8Array,
  start: number,
  end: number,
  compressionAlgorithm: number | null,
  warnings: string[],
) {
  const modules: PhoenixModule[] = [];
  let offset = start;
  while (offset + 24 <= end && modules.length < 8192) {
    if (bytes[offset] !== 0xf8) {
      // Phoenix can leave alignment padding between FFV modules.
      offset++;
      continue;
    }
    const size = u24(bytes, offset + 4);
    if (size < 24 || offset + size > end) {
      warnings.push(`FFV module at 0x${offset.toString(16)} exceeds its volume.`);
      break;
    }
    // A 0xF0 byte at +7 marks a directory/terminator entry, not a module.
    if (bytes[offset + 7] !== 0xf0) {
      const name = ffvModuleName(bytes, offset);
      const isSection = bytes[offset + 7] === 2;
      const section = offset + 24;
      const compressed = isSection && section + 12 <= offset + size && bytes[section + 3] === 1;
      const packedSize = compressed ? u24(bytes, section + 4) : undefined;
      const unpackedSize = compressed ? u24(bytes, section + 8) : undefined;
      const sectionSize = compressed ? u24(bytes, section) : undefined;
      const validCompression =
        compressed &&
        packedSize !== undefined &&
        unpackedSize !== undefined &&
        sectionSize !== undefined &&
        packedSize > 0 &&
        unpackedSize > 0 &&
        sectionSize >= packedSize + 12 &&
        section + sectionSize <= offset + size &&
        section + 12 + packedSize <= offset + size;
      if (compressed && !validCompression) {
        warnings.push(`Compressed section in ${name} exceeds its module.`);
      }
      modules.push({
        name,
        kind: isSection ? "section" : "raw",
        offset,
        size,
        compression:
          validCompression && (compressionAlgorithm === 2 || compressionAlgorithm === 3)
            ? "lh5"
            : compressed
              ? "unknown"
              : "none",
        ...(validCompression ? { packedSize, unpackedSize, payloadOffset: section + 12 } : {}),
      });
    }
    offset += size;
  }
  if (modules.length === 8192) {
    warnings.push("Phoenix module inventory exceeds its safety limit.");
  }
  return modules;
}

// Recognizes PhoenixBIOS 4.0's BCP/FFV directory (modern modular ROMs) or
// its older BCPSYS-linked module chain (a singly-linked list with its own
// cycle guard), and reports every module's offset/size/compression without
// decoding any of them. Returns null for anything that doesn't look like a
// bounded, well-formed Phoenix 4.0 image - see docs/phoenix/README.md for
// the real sample this was verified against.
export function inspectPhoenixLegacyBytes(bytes: Uint8Array): PhoenixLegacyInventory | null {
  if (find(bytes, "PhoenixBIOS") < 0 || bytes.length < 0x10000 || (bytes.length & (bytes.length - 1)) !== 0) {
    return null;
  }
  const sys = bcpRecord(bytes, "BCPSYS", 0x7b);
  const cmp = bcpRecord(bytes, "BCPCMP", 0x0c);
  if (sys < 0 || cmp < 0) return null;

  const buildCode = ascii(bytes, sys + 0x37, 8).replace(/\0/g, "").trim();
  const buildDate = ascii(bytes, sys + 0x0f, 8).replace(/\0/g, "").trim();
  const compressionAlgorithm = bytes[cmp + 0x0b] ?? null;
  const warnings: string[] = [];

  const ffv = bcpRecord(bytes, "BCPFFV", 14);
  if (ffv >= 0) {
    const directoryModuleOffset = u32(bytes, ffv + 10) & (bytes.length - 1);
    if (
      directoryModuleOffset + 32 <= bytes.length &&
      bytes[directoryModuleOffset] === 0xf8 &&
      ffvModuleName(bytes, directoryModuleOffset) === "volumedir.bin2"
    ) {
      const directory = directoryModuleOffset + 24;
      const directoryLength = u32(bytes, directory + 4);
      const moduleEnd = directoryModuleOffset + u24(bytes, directoryModuleOffset + 4);
      const entryCount = (directoryLength - 8) / 24;
      if (
        directoryLength >= 8 &&
        (directoryLength - 8) % 24 === 0 &&
        directory + directoryLength <= moduleEnd &&
        moduleEnd <= bytes.length &&
        entryCount <= 4096
      ) {
        const modules: PhoenixModule[] = [];
        for (let index = 0; index < entryCount; index++) {
          const entry = directory + 8 + index * 24;
          if (guid(bytes, entry) !== ffvVolumeGuid) continue;
          const volumeStart = u32(bytes, entry + 16) & (bytes.length - 1);
          const volumeLength = u32(bytes, entry + 20);
          if (volumeLength === 0 || volumeStart + volumeLength > bytes.length) {
            warnings.push(`FFV volume ${String(index)} exceeds the image.`);
            continue;
          }
          modules.push(
            ...readFfvModules(
              bytes,
              volumeStart,
              volumeStart + volumeLength,
              compressionAlgorithm,
              warnings,
            ),
          );
        }
        return {
          format: "phoenix-ffv",
          buildCode,
          buildDate,
          compressionAlgorithm,
          directoryOffset: directoryModuleOffset,
          volumeCount: entryCount,
          modules,
          warnings,
        };
      }
      warnings.push("The Phoenix FFV directory is malformed or truncated.");
    }
  }

  // No usable FFV directory: fall back to the older module chain BCPSYS
  // links to directly, a singly-linked list of fixed-header modules.
  let next = u32(bytes, sys + 0x77) & (bytes.length - 1);
  const visited = new Set<number>();
  const modules: PhoenixModule[] = [];
  while (next && next + 27 <= bytes.length && !visited.has(next) && visited.size < 2048) {
    visited.add(next);
    if (!matchesAt(bytes, next + 4, "\x0011")) {
      warnings.push(`Invalid Phoenix module header at 0x${next.toString(16)}.`);
      break;
    }
    const headerLength = bytes[next + 9];
    const packedSize = u32(bytes, next + 19);
    if (headerLength < 27 || next + headerLength + packedSize > bytes.length) {
      warnings.push(`Phoenix module at 0x${next.toString(16)} exceeds the image.`);
      break;
    }
    const type = String.fromCharCode(bytes[next + 8]);
    const compression = bytes[next + 10];
    modules.push({
      name: `${moduleTypeNames[type] ?? type}${String(bytes[next + 7])}.ROM`,
      kind: "legacy module",
      offset: next,
      size: headerLength + packedSize,
      compression: compression === 5 ? "lh5" : compression === 0 ? "none" : "unknown",
      packedSize,
      unpackedSize: u32(bytes, next + 15),
      payloadOffset: next + headerLength,
    });
    next = u32(bytes, next) & (bytes.length - 1);
  }
  if (next && visited.has(next)) {
    warnings.push("Phoenix module chain contains a cycle.");
  }

  return modules.length > 0
    ? {
        format: "phoenix-module-chain",
        buildCode,
        buildDate,
        compressionAlgorithm,
        directoryOffset: null,
        volumeCount: 0,
        modules,
        warnings,
      }
    : null;
}

// A Phoenix-derived UEFI image (as opposed to classic PhoenixBIOS 4.0) has
// no BCP/FFV structures at all - the only trace is CodeView (RSDS) debug
// records naming a \Phoenix\...\*.pdb module path, left over from the
// build. That's provenance for individual modules, never proof that the
// Setup HII in this image is Phoenix's: a real sample carried both Phoenix
// SecCore PDB paths and an unrelated Insyde copyright string side by side
// (see docs/phoenix/README.md), so this is reported as independent
// evidence, not a family verdict.
export function inspectPhoenixUefiBytes(bytes: Uint8Array): PhoenixUefiInventory | null {
  const modules = new Set<string>();
  let searchFrom = 0;
  while (modules.size < 64) {
    const rsds = find(bytes, "RSDS", searchFrom);
    if (rsds < 0) break;
    searchFrom = rsds + 4;
    const pathStart = rsds + 24;
    if (pathStart + 8 > bytes.length) continue;
    const scanEnd = Math.min(bytes.length, pathStart + 512);
    let terminator = pathStart;
    while (terminator < scanEnd && bytes[terminator] !== 0) terminator++;
    if (terminator === scanEnd) continue;
    const path = ascii(bytes, pathStart, terminator - pathStart);
    if (!/\\Phoenix\\/i.test(path) || !/\.pdb$/i.test(path)) continue;
    const segments = path.split("\\");
    const moduleName = segments[segments.length - 1]?.replace(/\.pdb$/i, "");
    if (moduleName && /^[A-Za-z0-9_+.-]{1,80}$/.test(moduleName)) {
      modules.add(moduleName);
    }
  }
  if (modules.size === 0) return null;
  return {
    secureCore: [...modules].some((name) => /^SecCore$/i.test(name)),
    debugModules: [...modules],
  };
}

// A modern Phoenix SecureCore UEFI build can still carry the same FFV
// module layout as classic PhoenixBIOS 4.0 for its legacy CMOS Setup
// Table (STRINGS0.ROM/TEMPLAT0.ROM), but without the "PhoenixBIOS" banner
// string or BCPSYS/BCPFFV directory inspectPhoenixLegacyBytes looks for -
// confirmed against a real 2 MiB laptop firmware sample whose only Phoenix
// evidence was a \Phoenix\...\*.pdb debug path (see
// inspectPhoenixUefiBytes), yet whose FFV modules (including a real
// TEMPLAT0.ROM/STRINGS0.ROM pair) decode identically to the BCP/FFV case.
// This scans directly for a named module's own 0xF8 header instead of
// requiring a directory to find it through, validating the same bounded
// compressed-section structure readFfvModules already checks.
export function findNamedPhoenixModule(bytes: Uint8Array, name: string): PhoenixModule | null {
  for (let offset = 0; offset + 24 <= bytes.length; offset++) {
    if (bytes[offset] !== 0xf8 || bytes[offset + 7] !== 2) continue;
    const size = u24(bytes, offset + 4);
    if (size < 24 || offset + size > bytes.length) continue;
    if (ffvModuleName(bytes, offset) !== name) continue;
    const section = offset + 24;
    if (section + 12 > offset + size || bytes[section + 3] !== 1) continue;
    const packedSize = u24(bytes, section + 4);
    const unpackedSize = u24(bytes, section + 8);
    const sectionSize = u24(bytes, section);
    const validCompression =
      packedSize > 0 &&
      unpackedSize > 0 &&
      sectionSize >= packedSize + 12 &&
      section + sectionSize <= offset + size &&
      section + 12 + packedSize <= offset + size;
    if (!validCompression) continue;
    return {
      name,
      kind: "section",
      offset,
      size,
      compression: "lh5",
      packedSize,
      unpackedSize,
      payloadOffset: section + 12,
    };
  }
  return null;
}
