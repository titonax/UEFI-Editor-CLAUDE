import type { Forms } from "./types";

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

function sameGuidOrBothUndefined(left?: string, right?: string) {
  return (left ?? "").toLowerCase() === (right ?? "").toLowerCase();
}

// Resolves what a Ref/menu entry's formId (+ optional formSetGuid) points
// at: a Form in the same FormSet takes priority (the common, same-FormSet
// Ref case), falling back to the first Form anywhere with a matching formId
// (a Ref that carries an explicit FormSetGuid, or a menu entry with none
// recorded). Returns -1 when nothing matches - a broken/dangling reference.
export function findFormIndexByFormId(
  forms: Forms,
  formId: string,
  formSetGuid?: string,
) {
  const normalized = normalizedHexId(formId);
  const inFormSet = forms.findIndex(
    (form) =>
      sameGuidOrBothUndefined(form.formSetGuid, formSetGuid) &&
      normalizedHexId(form.formId) === normalized,
  );

  return inFormSet >= 0
    ? inFormSet
    : forms.findIndex((form) => normalizedHexId(form.formId) === normalized);
}
