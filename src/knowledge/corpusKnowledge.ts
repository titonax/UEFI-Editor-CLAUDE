import { matchCases, type CaseSimilarity } from "./caseMatcher";
import { fingerprintFromCase, fingerprintFromEntry, type FingerprintField, type FirmwareFingerprint } from "./fingerprint";
import type { FirmwareCase } from "./schema";
import type { CorpusRunEntry } from "../components/scripts/corpusDashboard";

// A field on which an image and a recorded case were both observed and
// disagree, with both values so the difference can be read, not just counted.
export interface FieldDifference {
  field: FingerprintField;
  image: string | number;
  recorded: string | number;
}

// The recorded case an image is closest to, and why it is or is not the same
// kind of image: the fields that agree and the ones that do not.
export interface NearestCase {
  case: FirmwareCase;
  similarity: number;
  compared: number;
  agreeing: FingerprintField[];
  differing: FieldDifference[];
}

// How a corpus run's image relates to the recorded cases. Purely descriptive:
// nothing in the analysis changes because of it, and a vendor or manufacturer
// never enters into it.
export type KnowledgeVerdict =
  | { kind: "exact"; case: FirmwareCase }
  | ({ kind: "similar" } & NearestCase)
  // `nearest` is absent when no recorded case shares enough observed fields
  // with the image to be compared at all.
  | { kind: "novel"; nearest?: NearestCase };

// Minimum structural similarity (see caseMatcher.ts) to call an unknown image
// "similar" to a case. Below it the image is novel: worth recording.
export const similarThreshold = 0.8;

function describeNearest(image: FirmwareFingerprint, best: CaseSimilarity): NearestCase {
  const recorded = fingerprintFromCase(best.case);
  const differing: FieldDifference[] = [];
  for (const field of best.differing) {
    const imageValue = image[field];
    const recordedValue = recorded[field];
    if (imageValue !== undefined && recordedValue !== undefined) {
      differing.push({ field, image: imageValue, recorded: recordedValue });
    }
  }
  return {
    case: best.case,
    similarity: best.similarity,
    compared: best.compared,
    agreeing: best.agreeing,
    differing,
  };
}

export function classifyEntry(entry: CorpusRunEntry, cases: readonly FirmwareCase[]): KnowledgeVerdict {
  const fingerprint = fingerprintFromEntry(entry);
  const match = matchCases({ sha256: entry.sha256 || undefined, fingerprint }, cases);
  if (match.exact) return { kind: "exact", case: match.exact };
  const best = match.similar[0] as (typeof match.similar)[number] | undefined;
  if (!best) return { kind: "novel" };
  const nearest = describeNearest(fingerprint, best);
  return best.similarity >= similarThreshold ? { kind: "similar", ...nearest } : { kind: "novel", nearest };
}

export interface KnowledgeBreakdown {
  exact: number;
  similar: number;
  novel: number;
}

export function knowledgeBreakdown(
  entries: readonly CorpusRunEntry[],
  cases: readonly FirmwareCase[],
): KnowledgeBreakdown {
  const counts: KnowledgeBreakdown = { exact: 0, similar: 0, novel: 0 };
  for (const entry of entries) counts[classifyEntry(entry, cases).kind]++;
  return counts;
}

export interface NoveltyReasons {
  // For the new images, how many differ from their closest recorded case in
  // each field, most common first. It says where to look, not what is wrong.
  byField: { field: FingerprintField; cases: number }[];
  // New images with no recorded case close enough to compare against.
  noComparableCase: number;
}

export function noveltyReasons(
  entries: readonly CorpusRunEntry[],
  cases: readonly FirmwareCase[],
): NoveltyReasons {
  const byField = new Map<FingerprintField, number>();
  let noComparableCase = 0;
  for (const entry of entries) {
    const verdict = classifyEntry(entry, cases);
    if (verdict.kind !== "novel") continue;
    if (!verdict.nearest) {
      noComparableCase++;
      continue;
    }
    for (const difference of verdict.nearest.differing) {
      byField.set(difference.field, (byField.get(difference.field) ?? 0) + 1);
    }
  }
  return {
    byField: [...byField.entries()]
      .map(([field, count]) => ({ field, cases: count }))
      .sort((left, right) => right.cases - left.cases || left.field.localeCompare(right.field)),
    noComparableCase,
  };
}
