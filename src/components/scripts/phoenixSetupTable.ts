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
  | "action"
  | "boot-device-slot"
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
  // Pick Field's selectable value list: a packed array of string
  // references filling the record's own tail, from +16 up to its end
  // (so a 20-byte record carries 2 options, a 32-byte one up to 8).
  // Confirmed against real Enabled/Disabled, memory-size and mode-name
  // option lists across two independent firmware samples, and matches the
  // BIOS-modding tutorial's own worked example byte-for-byte. Always empty
  // for every other item type. An unused trailing slot (reference 0, or one
  // that doesn't resolve to a string) is left out rather than shown as
  // blank/garbage.
  options: string[];
  rawBytes: Uint8Array;
}

export interface PhoenixSetupSection {
  // TEMPLAT.ROM byte offset identifying this section: the tab's content
  // pointer list when it came from the root/tab table (see
  // parsePhoenixRootTable), or its first item's offset when it came from
  // the contiguous-run fallback scan (see scanPhoenixSetupSections). Either
  // way, a stable per-image identity for a section that isn't otherwise
  // addressable.
  offset: number;
  // The tab's real name (e.g. "Main", "Security"), resolved from the
  // root/tab table. Null for a fallback section, where no tab identity is
  // known - see PhoenixSetupMenu.source.
  name: string | null;
  items: PhoenixSetupItem[];
}

// Confirmed against the per-tab item-pointer list a root/tab table indexes
// into (see parsePhoenixRootTable): 0x20 is the real "date" companion to
// 0x21 "time" (both len 10, e.g. "System Date:"/"System Time:"). 0x22 was
// previously assumed to be a second date encoding by naming symmetry alone;
// real records (e.g. "Set Supervisor Password", "Set User Password") show
// it's a triggerable action with no editable value, like 0x24 (confirmed as
// the Exit screen's "Exit Saving Changes"/"Save Changes"/etc.) - just a
// longer record (len 18 vs 14) whose extra trailing bytes don't resolve to
// text and are left in rawBytes rather than guessed at. 0x27 is the Boot
// screen's device-slot entry (no prompt of its own - the device name isn't
// static text Phoenix could store at ROM-build time, since it depends on
// what's plugged in at boot).
function itemTypeOf(typeByte: number): PhoenixSetupItemType | null {
  switch (typeByte) {
    case 0x00:
    case 0x01:
      return "pick-field";
    case 0x10:
      return "generic-text";
    case 0x11:
      return "information";
    case 0x20:
      return "date";
    case 0x21:
      return "time";
    case 0x22:
    case 0x24:
      return "action";
    case 0x23:
      return "free-form-hex";
    case 0x27:
      return "boot-device-slot";
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

  if (type === "free-form-hex" || type === "boot-device-slot") {
    return { type, offset, length, prompt: null, help: null, options: [], rawBytes };
  }

  const promptRef = length >= 4 ? u16(bytes, offset + 2) : null;
  const helpRef = length >= 6 ? u16(bytes, offset + 4) : null;
  const prompt = promptRef === null ? null : resolveOrNull(table, promptRef);
  const help =
    (type === "pick-field" || type === "time" || type === "date" || type === "action") && helpRef !== null
      ? resolveOrNull(table, helpRef)
      : null;
  const options = type === "pick-field" ? parsePickFieldOptions(bytes, offset, length, table) : [];

  return { type, offset, length, prompt, help, options, rawBytes };
}

// Pick Field's option list: a packed array of string references filling
// the record from +16 to its end. See PhoenixSetupItem.options for how this
// was confirmed. Reference 0 and any reference that doesn't resolve to text
// mark an unused trailing slot in a shorter option list and are skipped.
function parsePickFieldOptions(
  bytes: Uint8Array,
  offset: number,
  length: number,
  table: PhoenixStringTable | null,
) {
  const options: string[] = [];
  for (let field = offset + 16; field + 2 <= offset + length; field += 2) {
    const reference = u16(bytes, field);
    if (reference === 0) continue;
    const resolved = resolveOrNull(table, reference);
    if (resolved !== null) options.push(resolved);
  }
  return options;
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
      sections.push({ offset: bestStart, name: null, items });
      position = bestEnd;
    } else {
      position++;
    }
  }
  return sections;
}

// Every TEMPLAT.ROM pointer field outside a string reference (the root
// table field itself, and every label/content/item pointer inside it) is
// PBE-relative like a string reference's slot lookup, not a raw TEMPLAT.ROM
// offset: add 4 to land on the real byte (see the module doc comment for
// why). Kept as a named helper since the root table leans on this
// convention far more than the rest of the parser does.
function pbeToRaw(pointer: number): number {
  return pointer + 4;
}

// TEMPLAT.ROM field (Phoenix BIOS Editor offset 0x0068) holding the real
// root/tab table's own pointer. Confirmed as the standard Phoenix legacy
// location for it across two independent, unrelated samples of the same
// laptop family: a pristine factory image and a later, differently
// restructured one (extra Advanced/Advanced2 split) from the same
// BIOS-modding project. A firmware that doesn't use this convention (e.g.
// one instead using the earlier ascending-directory addressing scheme
// found on an unrelated Acer sample) reads back 0 here, and callers should
// fall back to scanPhoenixSetupSections.
const ROOT_TABLE_FIELD_RAW_OFFSET = pbeToRaw(0x0068);
// Each tab entry is a (labelPointer, contentPointer) u16 pair; a
// (0, 0) pair marks the end of the table. 32 is generous headroom over the
// 6-8 tabs seen on real samples so a corrupt/missing terminator can't spin
// this into a very long scan.
const MAX_ROOT_TABLE_TABS = 32;
// A tab's content pointer leads to a list of (itemPointer, 0x0000) u16
// pairs - one per item actually shown on that tab - terminated by an
// itemPointer of 0. 200 is generous headroom over the largest real tab
// (Advanced2, 16 items) for the same reason.
const MAX_TAB_ITEMS = 200;

// Resolves a root-table label pointer to the tab's display name, e.g.
// "Main" or "Security". A label is always a Generic Text or Information
// item (confirmed on both cross-validation samples); anything else means
// this isn't really a label pointer, so this returns null rather than a
// nonsense guess.
function readTabLabel(bytes: Uint8Array, table: PhoenixStringTable | null, labelPointer: number): string | null {
  const rawOffset = pbeToRaw(labelPointer);
  if (rawOffset + 4 > bytes.length) return null;
  const typeByte = bytes[rawOffset];
  const length = bytes[rawOffset + 1];
  if ((typeByte !== 0x10 && typeByte !== 0x11) || length < 4 || rawOffset + length > bytes.length) return null;
  return resolveOrNull(table, u16(bytes, rawOffset + 2));
}

// Resolves a root-table content pointer to the tab's real item list. These
// items are not physically contiguous in TEMPLAT.ROM - they're interleaved
// with other tabs' and sub-menus' own items - which is exactly why
// scanPhoenixSetupSections's contiguous-run heuristic can misattribute or
// entirely miss a tab's content; this pointer list is the authoritative
// source once it resolves. Confirmed item-for-item against two independent
// samples: e.g. Information's 13 entries resolve to exactly "CPU Type:",
// "CPU Speed:", ... "UUID:" - the real System Information screen.
function readTabItems(bytes: Uint8Array, table: PhoenixStringTable | null, contentPointer: number): PhoenixSetupItem[] {
  const items: PhoenixSetupItem[] = [];
  let cursor = pbeToRaw(contentPointer);
  for (let step = 0; step < MAX_TAB_ITEMS && cursor + 4 <= bytes.length; step++, cursor += 4) {
    const itemPointer = u16(bytes, cursor);
    if (itemPointer === 0) break;
    const item = parseItem(bytes, pbeToRaw(itemPointer), table);
    if (item) items.push(item);
  }
  return items;
}

// Reads the real Setup tab layout - names and item membership - via
// TEMPLAT.ROM's root/tab table when present. Returns null (rather than an
// empty array) when the table isn't there, so buildPhoenixSetupMenu can
// tell "no tabs" apart from "fall back to the contiguous-run scan".
export function parsePhoenixRootTable(
  bytes: Uint8Array,
  table: PhoenixStringTable | null,
): PhoenixSetupSection[] | null {
  if (ROOT_TABLE_FIELD_RAW_OFFSET + 2 > bytes.length) return null;
  const rootPointer = u16(bytes, ROOT_TABLE_FIELD_RAW_OFFSET);
  if (rootPointer === 0) return null;
  const arrayRaw = pbeToRaw(rootPointer);

  const sections: PhoenixSetupSection[] = [];
  for (let tab = 0; tab < MAX_ROOT_TABLE_TABS; tab++) {
    const labelOffset = arrayRaw + tab * 4;
    const contentOffset = labelOffset + 2;
    if (contentOffset + 2 > bytes.length) break;
    const labelPointer = u16(bytes, labelOffset);
    const contentPointer = u16(bytes, contentOffset);
    if (labelPointer === 0 && contentPointer === 0) break;

    const name = readTabLabel(bytes, table, labelPointer);
    const items = readTabItems(bytes, table, contentPointer);
    if (name === null && items.length === 0) continue;
    sections.push({ offset: pbeToRaw(contentPointer), name, items });
  }
  return sections.length > 0 ? sections : null;
}

export interface PhoenixSetupMenu {
  sections: PhoenixSetupSection[];
  // "root-table" when sections carry their real Setup tab names and
  // authoritative item membership (see parsePhoenixRootTable); "contiguous-scan"
  // when they're the unnamed contiguous-run fallback (see
  // scanPhoenixSetupSections), used only when a firmware doesn't have (or
  // doesn't use) the root/tab table.
  source: "root-table" | "contiguous-scan";
}

// Combines the string table and the item-record scan into one read-only
// inventory of a Phoenix Setup's screens. `templat`/`strings` must already
// be decompressed (see decompressPhoenixLh5 in phoenixLh5.ts).
export function buildPhoenixSetupMenu(templat: Uint8Array, strings: Uint8Array): PhoenixSetupMenu {
  const table = parsePhoenixStringTable(strings);
  const rootTableSections = parsePhoenixRootTable(templat, table);
  if (rootTableSections) return { sections: rootTableSections, source: "root-table" };
  return { sections: scanPhoenixSetupSections(templat, table), source: "contiguous-scan" };
}
