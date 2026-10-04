// Read-only decoder for the Award 6.00PG `_ITEM.BIN` setup item table.
//
// Layout (see docs/award/README.md for the evidence): after a 16-byte
// module-name header ("_ITEM.BIN"), the table is a run of 25-byte records.
// The record stride and the field offsets below were recovered from the
// setup code's own loops (`add bx,0x19`, `[bx+8]` = CMOS address,
// `[bx+9]` = mask, `[bx+0x11] & 0x3f` = page, `test [bx],8` = skip/hide).
// None of it is checked against real hardware, so every field is reported
// as observed, never as a claim about what the BIOS will do.
//
// The table is not perfectly regular: some stretches use fillers or layouts
// the heuristic below does not recognise. The decoder therefore reports how
// many bytes it explained, and nothing here ever writes to a module.

const HEADER_BYTES = 0x10;
export const AWARD_ITEM_RECORD_BYTES = 25;
// "No CMOS bit behind this item" (a virtual/derived item).
const NO_CMOS_ADDRESS = 0xfd;

// Set in the flags word of an item to keep it out of the page's item list
// (awardext.rom's page builder: `test word [bx],8 ; jne next`). The setup code
// also sets this bit at run time for hardware-dependent items, so clearing it
// in the table only affects items that are hidden statically.
export const AWARD_ITEM_FLAG_HIDDEN = 0x0008;

export interface AwardItemRecord {
  // Offset of the record's flags word inside the decompressed module.
  offset: number;
  flags: number;
  hidden: boolean;
  id: number;
  group: number;
  mask: number;
  // Null for virtual items (no CMOS byte behind them).
  cmosAddress: number | null;
  maxValue: number;
  // Low six bits of the word at +0x11: the setup page the item belongs to.
  page: number;
  column: number;
  failSafe: number;
  optimal: number;
  link: number;
  link2: number;
}

export interface AwardItemTable {
  records: AwardItemRecord[];
  totalBytes: number;
  explainedBytes: number;
}

function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

const knownModes = new Set([0xf8, 0xf9, 0xfa, 0xfb, 0xff]);
const virtualSelectors = new Set([0x00, 0x01, 0x02, 0x03, 0x80, 0x81, 0x82, 0xff, 0x4a]);

// A record starts at `base`; fields are fixed offsets from it.
function looksLikeRecord(bytes: Uint8Array, base: number) {
  if (base + AWARD_ITEM_RECORD_BYTES > bytes.length) return false;
  if (!knownModes.has(bytes[base + 5])) return false;
  if (bytes[base + 3] > 0x11) return false;
  if (bytes[base + 0x12] === 0x02) return true;
  return (
    bytes[base + 8] === NO_CMOS_ADDRESS &&
    bytes[base + 9] === 1 &&
    bytes[base + 10] === 0 &&
    virtualSelectors.has(bytes[base + 4])
  );
}

function decodeRecord(bytes: Uint8Array, base: number): AwardItemRecord {
  const flags = u16(bytes, base);
  const pageWord = u16(bytes, base + 0x11);
  const cmos = bytes[base + 8];
  return {
    offset: base,
    flags,
    hidden: (flags & AWARD_ITEM_FLAG_HIDDEN) !== 0,
    id: bytes[base + 2],
    group: bytes[base + 3],
    mask: u16(bytes, base + 6),
    cmosAddress: cmos === NO_CMOS_ADDRESS ? null : cmos,
    maxValue: u16(bytes, base + 0x0f),
    page: pageWord & 0x3f,
    column: (pageWord >> 6) & 0xf,
    failSafe: u16(bytes, base + 0x13),
    optimal: u16(bytes, base + 0x15),
    link: u16(bytes, base + 0x0b),
    link2: u16(bytes, base + 0x17),
  };
}

// `bytes` is the decompressed `_ITEM.BIN` module. Returns null when it does
// not start with the module name or no record is recognised.
export function decodeAwardItemTable(bytes: Uint8Array): AwardItemTable | null {
  const name = "_ITEM.BIN";
  for (let index = 0; index < name.length; index += 1) {
    if (bytes[index] !== name.charCodeAt(index)) return null;
  }
  const records: AwardItemRecord[] = [];
  // Scan by the id/group pair (two bytes after the flags word), keeping
  // records contiguous: a candidate may not start before the previous ended.
  let nextFree = HEADER_BYTES;
  for (let unit = HEADER_BYTES; unit + AWARD_ITEM_RECORD_BYTES <= bytes.length; unit += 1) {
    const base = unit - 2;
    if (base < nextFree || !looksLikeRecord(bytes, base)) continue;
    records.push(decodeRecord(bytes, base));
    nextFree = base + AWARD_ITEM_RECORD_BYTES;
    unit = nextFree + 1;
  }
  if (records.length === 0) return null;
  return {
    records,
    totalBytes: bytes.length - HEADER_BYTES,
    explainedBytes: records.length * AWARD_ITEM_RECORD_BYTES,
  };
}

export function summarizeAwardItemPages(table: AwardItemTable) {
  const pages = new Map<number, { items: number; hidden: number }>();
  for (const record of table.records) {
    const entry = pages.get(record.page) ?? { items: 0, hidden: 0 };
    entry.items += 1;
    if (record.hidden) entry.hidden += 1;
    pages.set(record.page, entry);
  }
  return [...pages.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([page, counts]) => ({ page, ...counts }));
}
