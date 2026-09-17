import { decToHexString } from "./binaryPatcher";
import type { Offsets } from "./types";

// AMI SetupData carries one 54-byte "question metadata" record per HII
// question. A record is anchored by that question's own byte pairs from its
// IFR opcode - opcode bytes 6..7 at the record start, bytes 4..5 and 2..3
// further in - and around those anchors carries a page id, the AMI
// access-level byte, and the failsafe/optimal default bytes. The layout was
// reverse-engineered from firmware images (there is no public spec); the
// positions below are byte offsets from the record start.
export const SETUP_DATA_RECORD_BYTES = 54;
const PAGE_ID_OFFSET = 12;
const ACCESS_LEVEL_OFFSET = 16;
const ANCHOR_45_OFFSET = 20;
const ANCHOR_23_OFFSET = 48;
const FAILSAFE_OFFSET = 52;
const OPTIMAL_OFFSET = 53;

export interface SetupDataIndex {
  bytes: Uint8Array;
  // Every record-sized window start, keyed by its first two bytes (the
  // opcode bytes 6..7 anchor), so a lookup only visits the windows that can
  // match instead of regex-searching the whole hex string once per
  // question - thousands of questions against hundreds of KB.
  offsetsByPrefix: Map<number, number[]>;
}

export interface AdditionalData {
  pageId: string | null;
  accessLevel: string | null;
  failsafe: string | null;
  optimal: string | null;
  offsets: Offsets | null;
}

function prefixKey(first: number, second: number) {
  return (first << 8) | second;
}

// Malformed SetupData (odd length, non-hex) yields no records at all rather
// than a half-decoded buffer that could anchor a bogus match.
function decodeHex(hex: string) {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    return new Uint8Array();
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function byteHex(value: number) {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function noAdditionalData(): AdditionalData {
  return {
    pageId: null,
    accessLevel: null,
    failsafe: null,
    optimal: null,
    offsets: null,
  };
}

// Built once per parse and shared by every question lookup.
export function indexSetupData(hexSetupData: string): SetupDataIndex {
  const bytes = decodeHex(hexSetupData);
  const offsetsByPrefix = new Map<number, number[]>();
  for (let offset = 0; offset + SETUP_DATA_RECORD_BYTES <= bytes.length; offset++) {
    const key = prefixKey(bytes[offset], bytes[offset + 1]);
    const offsets = offsetsByPrefix.get(key);
    if (offsets) {
      offsets.push(offset);
    } else {
      offsetsByPrefix.set(key, [offset]);
    }
  }
  return { bytes, offsetsByPrefix };
}

// The SetupData record for one question, located by the anchors in the
// opcode's hex dump as IFRExtractor prints it ("0F 0F 01 00 ..."; only
// bytes 2..7 take part). Exactly one record must match: none means the
// question has no metadata, more than one means the anchors are ambiguous
// and nothing is reported rather than guessing.
export function getAdditionalData(
  opcodeBytes: string,
  setupData: SetupDataIndex,
  isRef: boolean,
): AdditionalData {
  const anchor = opcodeBytes
    .split(" ")
    .slice(2, 8)
    .map((value) => Number.parseInt(value, 16));
  if (anchor.length < 6 || anchor.some((value) => Number.isNaN(value))) {
    return noAdditionalData();
  }
  const [a2, a3, a4, a5, a6, a7] = anchor;
  const { bytes } = setupData;

  const matches: number[] = [];
  let nextAllowedOffset = 0;
  for (const offset of setupData.offsetsByPrefix.get(prefixKey(a6, a7)) ?? []) {
    // Records never overlap: a window inside the previous match is skipped.
    if (offset < nextAllowedOffset) continue;
    if (
      bytes[offset + ANCHOR_45_OFFSET] === a4 &&
      bytes[offset + ANCHOR_45_OFFSET + 1] === a5 &&
      bytes[offset + ANCHOR_23_OFFSET] === a2 &&
      bytes[offset + ANCHOR_23_OFFSET + 1] === a3
    ) {
      matches.push(offset);
      nextAllowedOffset = offset + SETUP_DATA_RECORD_BYTES;
    }
  }
  if (matches.length !== 1) {
    return noAdditionalData();
  }

  const [start] = matches;
  const offsets: Offsets = {
    accessLevel: decToHexString(start + ACCESS_LEVEL_OFFSET),
    failsafe: decToHexString(start + FAILSAFE_OFFSET),
    optimal: decToHexString(start + OPTIMAL_OFFSET),
  };
  if (isRef) {
    offsets.pageId = decToHexString(start + PAGE_ID_OFFSET);
  }
  return {
    pageId:
      byteHex(bytes[start + PAGE_ID_OFFSET]) +
      byteHex(bytes[start + PAGE_ID_OFFSET + 1]),
    accessLevel: byteHex(bytes[start + ACCESS_LEVEL_OFFSET]),
    failsafe: byteHex(bytes[start + FAILSAFE_OFFSET]),
    optimal: byteHex(bytes[start + OPTIMAL_OFFSET]),
    offsets,
  };
}
