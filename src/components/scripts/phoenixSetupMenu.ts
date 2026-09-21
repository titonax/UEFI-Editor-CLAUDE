// Ties the Phoenix module inventory, LH5 decompression and Setup-table
// parsing together into one read-only Setup menu inventory - the Phoenix
// counterpart to the AMI Aptio HII menu tree. Never used for anything AMI
// Aptio parses or edits; see docs/phoenix/README.md for what's verified
// and against which real samples.
import {
  findNamedPhoenixModule,
  inspectPhoenixLegacyBytes,
  type PhoenixModule,
} from "./phoenixFirmware";
import { decompressPhoenixLh5 } from "./phoenixLh5";
import { buildPhoenixSetupMenu, type PhoenixSetupMenu } from "./phoenixSetupTable";

const templatNamePattern = /^TEMPLAT\d+\.ROM$/i;
const stringsNamePattern = /^STRINGS\d+\.ROM$/i;

function findModule(modules: PhoenixModule[], pattern: RegExp) {
  return modules.find((module) => pattern.test(module.name) && module.packedSize !== undefined);
}

// Locates the two modules a Setup menu needs, either from an already-run
// legacy FFV/module-chain inventory (see inspectPhoenixLegacyBytes) or, when
// that found nothing (no "PhoenixBIOS" banner/BCPSYS directory - a modern
// Phoenix SecureCore UEFI build can still carry the same FFV Setup Table
// modules), by scanning directly for each module's own FFV header.
function locateSetupModules(bytes: Uint8Array, legacyModules: PhoenixModule[] | undefined) {
  const templat =
    (legacyModules && findModule(legacyModules, templatNamePattern)) ??
    findNamedPhoenixModule(bytes, "TEMPLAT0.ROM");
  const strings =
    (legacyModules && findModule(legacyModules, stringsNamePattern)) ??
    findNamedPhoenixModule(bytes, "STRINGS0.ROM");
  if (!templat || !strings || templat.payloadOffset === undefined || strings.payloadOffset === undefined) {
    return null;
  }
  return { templat, strings };
}

function modulePayload(bytes: Uint8Array, module: PhoenixModule) {
  const payloadOffset = module.payloadOffset;
  const packedSize = module.packedSize;
  if (payloadOffset === undefined || packedSize === undefined) return null;
  return bytes.subarray(payloadOffset, payloadOffset + packedSize);
}

// Finds, decompresses and parses a Phoenix Setup Table (STRINGS0.ROM +
// TEMPLAT0.ROM) directly from raw firmware bytes. Returns null when either
// module can't be located, isn't LH5-compressed, or fails to decompress -
// this is a best-effort inventory, not a requirement for anything else
// this editor does.
export async function inspectPhoenixSetupMenu(bytes: Uint8Array): Promise<PhoenixSetupMenu | null> {
  const legacy = inspectPhoenixLegacyBytes(bytes);
  const located = locateSetupModules(bytes, legacy?.modules);
  if (!located) return null;
  const { templat, strings } = located;
  const templatCompressed = modulePayload(bytes, templat);
  const stringsCompressed = modulePayload(bytes, strings);
  if (!templatCompressed || !stringsCompressed || templat.unpackedSize === undefined || strings.unpackedSize === undefined) {
    return null;
  }
  try {
    const [templatBytes, stringsBytes] = await Promise.all([
      decompressPhoenixLh5(templatCompressed, templat.unpackedSize),
      decompressPhoenixLh5(stringsCompressed, strings.unpackedSize),
    ]);
    return buildPhoenixSetupMenu(templatBytes, stringsBytes);
  } catch {
    return null;
  }
}
