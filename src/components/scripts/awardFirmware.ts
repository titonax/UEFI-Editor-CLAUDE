// Read-only inventory of a Phoenix-Award 6.00PG BIOS image.
//
// Award 6.00PG stores its modules as a chain of LHA level-1 archive entries
// (`-lh5-` compressed or `-lh0-` stored), one after another, with the
// compressed payload following each header directly. This walks that chain,
// verifies every header checksum, and can decompress a named module. It never
// writes anything: see docs/award/README.md for what is and is not known.
import { decodeAwardItemTable, type AwardItemTable } from "./awardItemTable";
import { decompressPhoenixLh5 } from "./phoenixLh5";

export interface AwardModule {
  name: string;
  method: "-lh0-" | "-lh5-";
  // Offset of the LHA header's first byte.
  offset: number;
  // Offset and length of the (possibly compressed) payload.
  dataOffset: number;
  packedSize: number;
  originalSize: number;
}

export interface AwardInventory {
  modules: AwardModule[];
}

const MIN_MODULES = 3;
const MIN_HEADER = 22;
const MAX_HEADER = 0xff;

function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function parseModuleAt(bytes: Uint8Array, offset: number): AwardModule | null {
  if (offset + MIN_HEADER + 2 > bytes.length) return null;
  const headerLength = bytes[offset];
  if (headerLength < MIN_HEADER || headerLength > MAX_HEADER) return null;
  // "-lh0-" or "-lh5-", header level 1.
  if (
    bytes[offset + 2] !== 0x2d ||
    bytes[offset + 3] !== 0x6c ||
    bytes[offset + 4] !== 0x68 ||
    bytes[offset + 6] !== 0x2d ||
    bytes[offset + 20] !== 1
  ) {
    return null;
  }
  const digit = String.fromCharCode(bytes[offset + 5]);
  if (digit !== "0" && digit !== "5") return null;
  const headerEnd = offset + 2 + headerLength;
  if (headerEnd > bytes.length) return null;
  let checksum = 0;
  for (let index = offset + 2; index < headerEnd; index += 1) checksum += bytes[index];
  if ((checksum & 0xff) !== bytes[offset + 1]) return null;

  const nameLength = bytes[offset + 21];
  if (22 + nameLength > headerLength + 2) return null;
  let name = "";
  for (let index = 0; index < nameLength; index += 1) {
    const code = bytes[offset + 22 + index];
    if (code < 0x20 || code > 0x7e) return null;
    name += String.fromCharCode(code);
  }

  // In a level-1 header "skip size" covers the extended headers as well as
  // the payload; the extended headers form a chain whose first size is the
  // last two bytes of the base header.
  const skipSize = u32(bytes, offset + 7);
  const originalSize = u32(bytes, offset + 11);
  let extended = 0;
  let next = u16(bytes, headerEnd - 2);
  while (next !== 0) {
    const start = headerEnd + extended;
    if (next < 3 || start + next > bytes.length) return null;
    extended += next;
    next = u16(bytes, start + next - 2);
  }
  if (extended > skipSize) return null;
  const packedSize = skipSize - extended;
  const dataOffset = headerEnd + extended;
  if (dataOffset + packedSize > bytes.length) return null;
  return {
    name,
    method: digit === "0" ? "-lh0-" : "-lh5-",
    offset,
    dataOffset,
    packedSize,
    originalSize,
  };
}

// Walks the module chain. Returns null when fewer than MIN_MODULES valid,
// checksum-verified entries are found, so a stray "-lh5-" string in an
// unrelated image never reads as an Award BIOS.
export function inspectAwardBytes(bytes: Uint8Array): AwardInventory | null {
  const modules: AwardModule[] = [];
  let offset = 0;
  while (offset < bytes.length - MIN_HEADER) {
    const module = parseModuleAt(bytes, offset);
    if (module) {
      modules.push(module);
      offset = module.dataOffset + module.packedSize;
    } else {
      offset += 1;
    }
  }
  return modules.length >= MIN_MODULES ? { modules } : null;
}

export function findAwardModule(inventory: AwardInventory, name: string) {
  const lower = name.toLowerCase();
  return inventory.modules.find((module) => module.name.toLowerCase() === lower) ?? null;
}

export async function readAwardModule(bytes: Uint8Array, module: AwardModule) {
  const payload = bytes.subarray(module.dataOffset, module.dataOffset + module.packedSize);
  if (module.method === "-lh0-") return payload.slice(0, module.originalSize);
  return decompressPhoenixLh5(payload, module.originalSize);
}

export interface AwardImageInspection {
  inventory: AwardInventory;
  itemTable: AwardItemTable | null;
  itemTableError: string | null;
}

// The inventory plus the decoded `_ITEM.BIN`, when the image carries one.
export async function inspectAwardImage(bytes: Uint8Array): Promise<AwardImageInspection | null> {
  const inventory = inspectAwardBytes(bytes);
  if (!inventory) return null;
  const item = findAwardModule(inventory, "_ITEM.BIN");
  if (!item) return { inventory, itemTable: null, itemTableError: null };
  try {
    const decoded = decodeAwardItemTable(await readAwardModule(bytes, item));
    return { inventory, itemTable: decoded, itemTableError: null };
  } catch (reason: unknown) {
    return {
      inventory,
      itemTable: null,
      itemTableError: reason instanceof Error ? reason.message : String(reason),
    };
  }
}
