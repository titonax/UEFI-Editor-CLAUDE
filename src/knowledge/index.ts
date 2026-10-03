import { findCollectionProblems, validateFirmwareCase, type FirmwareCase } from "./schema";

// Every JSON file under cases/ is one FirmwareCase. They are bundled at build
// time and validated on load, so a malformed case fails loudly instead of
// quietly shaping a match.
export function loadCases(modules: Record<string, unknown>): FirmwareCase[] {
  const cases: FirmwareCase[] = [];
  for (const [path, module] of Object.entries(modules)) {
    const result = validateFirmwareCase(module);
    if (!result.ok) throw new Error(`Invalid firmware case ${path}: ${result.errors.join(" ")}`);
    cases.push(result.value);
  }
  const problems = findCollectionProblems(cases);
  if (problems.length > 0) throw new Error(`Invalid firmware case collection: ${problems.join(" ")}`);
  return cases.sort((left, right) => left.id.localeCompare(right.id));
}

export const knownCases: FirmwareCase[] = loadCases(
  import.meta.glob("./cases/**/*.json", { eager: true, import: "default" }),
);

export { matchCases } from "./caseMatcher";
export { fingerprintFromCase, fingerprintFromEntry } from "./fingerprint";
export type { FirmwareFingerprint } from "./fingerprint";
export type { FirmwareCase } from "./schema";
