// FormId/QuestionId/VarStoreId values throughout the parsed IFR data are
// hex strings like "0x0001". parseInt() auto-detects the "0x" prefix, but
// leaving the radix implicit makes every call site look like a bug waiting
// to happen if a non-prefixed value ever shows up. These helpers make the
// base explicit in one place.
export function parseHexId(value: string) {
  return parseInt(value, 16);
}

export function sameHexId(a: string, b: string) {
  return parseHexId(a) === parseHexId(b);
}

// Normalizes a hex id to its decimal string form so ids can be used as
// Map/Set keys or compared for equality regardless of formatting
// (leading zeros, casing, etc.). Falls back to the original string when it
// doesn't parse as a number at all.
export function normalizedHexId(value: string) {
  const parsed = parseHexId(value);
  return Number.isNaN(parsed) ? value : String(parsed);
}
