import { fingerprintFields, fingerprintFromCase, type FingerprintField, type FirmwareFingerprint } from "./fingerprint";
import type { FirmwareCase } from "./schema";

// Structural similarity is the share of comparable fields on which two
// fingerprints agree. It says how alike two images are as observed, NOT how
// likely an image is to be a given vendor or generation. Fields unknown on
// either side are not compared.
export interface CaseSimilarity {
  case: FirmwareCase;
  // 0..1: agreeing fields / compared fields.
  similarity: number;
  compared: number;
  agreeing: FingerprintField[];
  differing: FingerprintField[];
}

export interface CaseMatch {
  // The case describing this very image (same SHA-256), when there is one.
  exact?: FirmwareCase;
  // Other cases ordered from most to least similar. Never contains `exact`.
  similar: CaseSimilarity[];
}

// Below this many comparable fields a percentage means nothing (one shared
// container type would read as 100%), so such pairs are not reported.
export const minimumComparedFields = 3;

export function compareFingerprints(
  left: FirmwareFingerprint,
  right: FirmwareFingerprint,
): Omit<CaseSimilarity, "case"> {
  const agreeing: FingerprintField[] = [];
  const differing: FingerprintField[] = [];
  for (const field of fingerprintFields) {
    const a = left[field];
    const b = right[field];
    if (a === undefined || b === undefined) continue;
    (a === b ? agreeing : differing).push(field);
  }
  const compared = agreeing.length + differing.length;
  return { similarity: compared === 0 ? 0 : agreeing.length / compared, compared, agreeing, differing };
}

export function matchCases(
  subject: { sha256?: string; fingerprint: FirmwareFingerprint },
  cases: readonly FirmwareCase[],
  options: { minimumCompared?: number; limit?: number } = {},
): CaseMatch {
  const sha = subject.sha256?.toLowerCase();
  const exact = sha ? cases.find((entry) => entry.sha256 === sha) : undefined;
  const minimum = options.minimumCompared ?? minimumComparedFields;
  const similar = cases
    .filter((entry) => entry !== exact)
    .map((entry) => ({ case: entry, ...compareFingerprints(subject.fingerprint, fingerprintFromCase(entry)) }))
    .filter((entry) => entry.compared >= minimum)
    .sort(
      (left, right) =>
        right.similarity - left.similarity ||
        right.compared - left.compared ||
        left.case.id.localeCompare(right.case.id),
    )
    .slice(0, options.limit ?? 5);
  return { exact, similar };
}
