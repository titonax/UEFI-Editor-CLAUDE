import { findRuleProblems, validateFirmwareRule, type FirmwareRule } from "./ruleSchema";
import { caseDirectory, findCollectionProblems, validateFirmwareCase, type FirmwareCase } from "./schema";

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
  // A case lives at cases/<family directory>/<id>.json, so a file can be found
  // from its id and two files can never silently claim the same one.
  for (const [path, module] of Object.entries(modules)) {
    const found = cases.find((entry) => entry.id === (module as { id?: unknown }).id);
    const expected = found && `./cases/${caseDirectory(found.vendorFamily)}/${found.id}.json`;
    if (expected !== undefined && path !== expected) {
      throw new Error(`Firmware case ${path} is misplaced: expected ${expected}.`);
    }
  }
  return cases.sort((left, right) => left.id.localeCompare(right.id));
}

export const knownCases: FirmwareCase[] = loadCases(
  import.meta.glob("./cases/**/*.json", { eager: true, import: "default" }),
);

// Every JSON file under rules/ is one FirmwareRule, validated on load and
// cross-checked against the recorded cases it cites. A rule file lives at
// rules/<id>.json.
export function loadRules(modules: Record<string, unknown>, cases: readonly FirmwareCase[]): FirmwareRule[] {
  const loaded: { path: string; rule: FirmwareRule }[] = [];
  for (const [path, module] of Object.entries(modules)) {
    const result = validateFirmwareRule(module);
    if (!result.ok) throw new Error(`Invalid firmware rule ${path}: ${result.errors.join(" ")}`);
    loaded.push({ path, rule: result.value });
  }
  const rules = loaded.map((entry) => entry.rule);
  const problems = findRuleProblems(rules, cases);
  if (problems.length > 0) throw new Error(`Invalid firmware rule collection: ${problems.join(" ")}`);
  for (const { path, rule } of loaded) {
    const expected = `./rules/${rule.id}.json`;
    if (path !== expected) throw new Error(`Firmware rule ${path} is misplaced: expected ${expected}.`);
  }
  return rules.sort((left, right) => left.id.localeCompare(right.id));
}

export const knownRules: FirmwareRule[] = loadRules(
  import.meta.glob("./rules/*.json", { eager: true, import: "default" }),
  knownCases,
);

export { matchCases } from "./caseMatcher";
export { fingerprintFromCase, fingerprintFromEntry } from "./fingerprint";
export type { FirmwareFingerprint } from "./fingerprint";
export type { FirmwareCase } from "./schema";
export type { FirmwareRule } from "./ruleSchema";
