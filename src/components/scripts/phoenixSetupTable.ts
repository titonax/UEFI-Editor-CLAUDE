// Read-only parser for a decompressed Phoenix legacy BIOS Setup "template"
// pair (STRINGS.ROM + TEMPLAT.ROM), the format Phoenix BIOS Editor and
// Phoenix SLIC Tool work with once a firmware's SETUP0.ROM/STRINGS0.ROM/
// TEMPLAT0.ROM modules are LH5-decompressed (see phoenixLh5.ts). Byte
// layout below is reverse-engineered from a real-world BIOS-modding
// tutorial plus independent verification against real decompressed Phoenix
// firmware samples - see docs/phoenix/README.md for both. This only ever
// inventories what a Setup screen contains; it never edits a template.

function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

const stringPackSignature = "STRPACK-BIOS";

export interface PhoenixStringTable {
  bytes: Uint8Array;
  // Every string reference in TEMPLAT.ROM is an offset of a 2-byte slot in
  // this table (relative to tableBase), not of the text itself: the slot
  // holds a second offset (also relative to tableBase) where the actual
  // null-terminated text lives. Confirmed against multiple real Prompt/Help
  // pairs (e.g. "F12 Boot Menu:" / its help text) from a real Phoenix image.
  tableBase: number;
}

// Locates the STRPACK-BIOS signature and its trailing language table, and
// returns the base every string reference in TEMPLAT.ROM is relative to.
// Returns null for anything that isn't a recognizable Phoenix string pack.
export function parsePhoenixStringTable(bytes: Uint8Array): PhoenixStringTable | null {
  const signatureBytes = new TextEncoder().encode(stringPackSignature);
  let signatureOffset = -1;
  for (let offset = 0; offset + signatureBytes.length <= bytes.length; offset++) {
    if (signatureBytes.every((byte, index) => bytes[offset + index] === byte)) {
      signatureOffset = offset;
      break;
    }
  }
  if (signatureOffset < 0) return null;

  let offset = signatureOffset + signatureBytes.length;
  while (offset < bytes.length && bytes[offset] === 0) offset++;
  if (offset + 2 > bytes.length) return null;
  const languageCount = u16(bytes, offset);
  offset += 2;
  if (languageCount < 1 || languageCount > 32) return null;
  offset += languageCount * 2;
  if (offset > bytes.length) return null;

  return { bytes, tableBase: offset };
}

// Resolves a TEMPLAT.ROM string reference to text via the table's own
// double indirection (reference -> table slot -> text offset -> C string).
// Returns null rather than throwing for a reference that doesn't resolve
// to a sane, boundedly-terminated string - a Setup screen with unusual or
// unreferenced slots is expected, not a parse failure.
export function resolvePhoenixString(table: PhoenixStringTable, reference: number): string | null {
  const slotAddress = table.tableBase + reference;
  if (slotAddress < 0 || slotAddress + 2 > table.bytes.length) return null;
  const textOffset = u16(table.bytes, slotAddress);
  const textAddress = table.tableBase + textOffset;
  if (textAddress < 0 || textAddress >= table.bytes.length) return null;
  let end = textAddress;
  const scanLimit = Math.min(table.bytes.length, textAddress + 512);
  while (end < scanLimit && table.bytes[end] !== 0) end++;
  if (end === scanLimit) return null;
  return new TextDecoder("latin1").decode(table.bytes.subarray(textAddress, end));
}

export type PhoenixSetupItemType =
  | "pick-field"
  | "generic-text"
  | "information"
  | "time"
  | "date"
  | "free-form-hex";

// One entry in a Phoenix Setup screen. Only the fields independently
// confirmed against real byte layouts are named; everything else in the
// record is kept as rawBytes rather than guessed at.
export interface PhoenixSetupItem {
  type: PhoenixSetupItemType;
  offset: number;
  length: number;
  // Resolved via the string table when the item carries a recognized
  // prompt/label reference (every type here except free-form-hex).
  prompt: string | null;
  // Pick Field and Time/Date items carry a second string reference,
  // conventionally help text.
  help: string | null;
  rawBytes: Uint8Array;
}

export interface PhoenixSetupSection {
  // TEMPLAT.ROM byte offset of this section's first item - a stable
  // per-image identity, since sections aren't otherwise named.
  offset: number;
  items: PhoenixSetupItem[];
}

function itemTypeOf(typeByte: number): PhoenixSetupItemType | null {
  switch (typeByte) {
    case 0x00:
    case 0x01:
      return "pick-field";
    case 0x10:
      return "generic-text";
    case 0x11:
      return "information";
    case 0x21:
      return "time";
    case 0x22:
      return "date";
    case 0x23:
      return "free-form-hex";
    default:
      return null;
  }
}

function resolveOrNull(table: PhoenixStringTable | null, reference: number) {
  return table ? resolvePhoenixString(table, reference) : null;
}

// Every item type here starts with a 1-byte type + 1-byte total record
// length (length includes this 2-byte header), confirmed structurally: a
// real decompressed TEMPLAT.ROM walks as one continuous run of these
// records with zero gaps across thousands of bytes. Prompt/help string
// references sit at a fixed +2/+4 offset for every type that carries them,
// confirmed against real Pick Field ("F12 Boot Menu:" / its help text),
// Generic Text ("Main") and Information records.
function parseItem(bytes: Uint8Array, offset: number, table: PhoenixStringTable | null): PhoenixSetupItem | null {
  const typeByte = bytes[offset];
  const type = itemTypeOf(typeByte);
  const length = bytes[offset + 1];
  if (type === null || length < 2 || offset + length > bytes.length) return null;
  const rawBytes = bytes.subarray(offset, offset + length);

  if (type === "free-form-hex") {
    return { type, offset, length, prompt: null, help: null, rawBytes };
  }

  const promptRef = length >= 4 ? u16(bytes, offset + 2) : null;
  const helpRef = length >= 6 ? u16(bytes, offset + 4) : null;
  const prompt = promptRef === null ? null : resolveOrNull(table, promptRef);
  const help =
    (type === "pick-field" || type === "time" || type === "date") && helpRef !== null
      ? resolveOrNull(table, helpRef)
      : null;

  return { type, offset, length, prompt, help, rawBytes };
}

// The number of consecutive valid item records starting at `offset`,
// without actually materializing them - used to find where a section
// begins/ends by preferring the longest run over any shorter one that
// happens to start on the same bytes (see scanPhoenixSetupSections).
function runLength(bytes: Uint8Array, offset: number) {
  let cursor = offset;
  let count = 0;
  while (cursor + 2 <= bytes.length) {
    const type = itemTypeOf(bytes[cursor]);
    const length = bytes[cursor + 1];
    if (type === null || length < 2 || cursor + length > bytes.length) break;
    count++;
    cursor += length;
    if (count > 5000) break;
  }
  return { count, end: cursor };
}

const MIN_SECTION_ITEMS = 5;
// How far ahead of the current scan position to look for a better
// (longer) run before settling for a shorter one - real sections are
// contiguous, so a genuine section start is never more than a handful of
// bytes past a false-positive one.
const SECTION_SEARCH_WINDOW = 64;

// Walks a decompressed TEMPLAT.ROM looking for maximal runs of
// back-to-back, validly-framed item records - real Phoenix Setup screens
// lay their items out contiguously, so this finds every screen's item list
// without needing to locate (or guess the addressing base of) the
// tab/section directory that points into them. Confirmed against a real
// 39 KiB decompressed TEMPLAT.ROM: this finds every screen (Main, Security,
// Boot, chipset workaround screens, ...) as its own contiguous run.
export function scanPhoenixSetupSections(
  bytes: Uint8Array,
  table: PhoenixStringTable | null,
): PhoenixSetupSection[] {
  const sections: PhoenixSetupSection[] = [];
  let position = 0;
  while (position < bytes.length) {
    let bestCount = 0;
    let bestStart = position;
    let bestEnd = position;
    const searchEnd = Math.min(position + SECTION_SEARCH_WINDOW, bytes.length);
    for (let start = position; start < searchEnd; start++) {
      const { count, end } = runLength(bytes, start);
      if (count > bestCount) {
        bestCount = count;
        bestStart = start;
        bestEnd = end;
      }
    }
    if (bestCount >= MIN_SECTION_ITEMS) {
      const items: PhoenixSetupItem[] = [];
      let cursor = bestStart;
      while (cursor < bestEnd) {
        const item = parseItem(bytes, cursor, table);
        if (!item) break;
        items.push(item);
        cursor += item.length;
      }
      sections.push({ offset: bestStart, items });
      position = bestEnd;
    } else {
      position++;
    }
  }
  return sections;
}

export interface PhoenixSetupMenu {
  sections: PhoenixSetupSection[];
}

// Combines the string table and the item-record scan into one read-only
// inventory of a Phoenix Setup's screens. `templat`/`strings` must already
// be decompressed (see decompressPhoenixLh5 in phoenixLh5.ts).
export function buildPhoenixSetupMenu(templat: Uint8Array, strings: Uint8Array): PhoenixSetupMenu {
  const table = parsePhoenixStringTable(strings);
  return { sections: scanPhoenixSetupSections(templat, table) };
}
