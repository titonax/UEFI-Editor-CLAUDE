import type { AmiFirmwareGeneration, FirmwareContainer, FirmwareVendorFamily } from "../components/scripts/amiFirmwareImage";
import type { CorpusRunEntry } from "../components/scripts/corpusDashboard";
import type { FirmwareCase } from "./schema";

// The comparable shape of an analysed image. Every field is optional because
// the two sources differ in what they observed (a case recorded from a docs
// table has volume counts but no HII counts; a live corpus run has HII counts
// but not volume counts). A field that is absent is unknown and is skipped
// when two fingerprints are compared - it never counts for or against a match.
export interface FirmwareFingerprint {
  container?: FirmwareContainer;
  vendorFamily?: FirmwareVendorFamily;
  generation?: AmiFirmwareGeneration;
  firmwareVolumes?: number;
  ffs2Files?: number;
  ffs3Files?: number;
  directSetupFiles?: number;
  contextCount?: number;
  formSets?: number;
  forms?: number;
  refs?: number;
  navigation?: string;
}

export const fingerprintFields = [
  "container",
  "vendorFamily",
  "generation",
  "firmwareVolumes",
  "ffs2Files",
  "ffs3Files",
  "directSetupFiles",
  "contextCount",
  "formSets",
  "forms",
  "refs",
  "navigation",
] as const satisfies readonly (keyof FirmwareFingerprint)[];
export type FingerprintField = (typeof fingerprintFields)[number];

function compact(fingerprint: FirmwareFingerprint): FirmwareFingerprint {
  return Object.fromEntries(
    Object.entries(fingerprint).filter(([, value]) => value !== undefined),
  ) as FirmwareFingerprint;
}

export function fingerprintFromCase(entry: FirmwareCase): FirmwareFingerprint {
  return compact({
    container: entry.container === "unknown" ? undefined : entry.container,
    vendorFamily: entry.vendorFamily === "unknown" ? undefined : entry.vendorFamily,
    generation: entry.generation,
    ...entry.features,
  });
}

// Derived from what the corpus runner already measured for one image. Nothing
// is re-analysed here: this only reshapes the runner's own result.
export function fingerprintFromEntry(entry: CorpusRunEntry): FirmwareFingerprint {
  const report = entry.report;
  return compact({
    container: entry.container === undefined || entry.container === "unknown" ? undefined : entry.container,
    vendorFamily:
      entry.vendorGuess === undefined || entry.vendorGuess.family === "unknown"
        ? undefined
        : entry.vendorGuess.family,
    generation: entry.generation?.generation,
    contextCount: entry.contextCount,
    formSets: report?.counts.formSets,
    forms: report?.counts.forms,
    refs: report?.counts.refs,
    navigation: report?.navigation.mechanism,
  });
}
