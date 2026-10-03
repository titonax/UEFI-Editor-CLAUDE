import { matchCases } from "./caseMatcher";
import { fingerprintFromEntry } from "./fingerprint";
import type { FirmwareCase } from "./schema";
import type { CorpusRunEntry } from "../components/scripts/corpusDashboard";

// How a corpus run's image relates to the recorded cases. Purely descriptive:
// nothing in the analysis changes because of it, and a vendor or manufacturer
// never enters into it.
export type KnowledgeVerdict =
  | { kind: "exact"; case: FirmwareCase }
  | { kind: "similar"; case: FirmwareCase; similarity: number; compared: number }
  | { kind: "novel" };

// Minimum structural similarity (see caseMatcher.ts) to call an unknown image
// "similar" to a case. Below it the image is novel: worth recording.
export const similarThreshold = 0.8;

export function classifyEntry(entry: CorpusRunEntry, cases: readonly FirmwareCase[]): KnowledgeVerdict {
  const match = matchCases({ sha256: entry.sha256 || undefined, fingerprint: fingerprintFromEntry(entry) }, cases);
  if (match.exact) return { kind: "exact", case: match.exact };
  const best = match.similar[0] as (typeof match.similar)[number] | undefined;
  if (best && best.similarity >= similarThreshold) {
    return { kind: "similar", case: best.case, similarity: best.similarity, compared: best.compared };
  }
  return { kind: "novel" };
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
