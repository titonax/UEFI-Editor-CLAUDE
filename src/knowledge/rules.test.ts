import { describe, expect, it } from "vitest";
import { knownCases, knownRules, loadRules } from "./index";
import { ruleWarnings } from "./ruleSchema";

// Lazy globs: only the file names are used, nothing is imported.
const repositoryFiles = new Set(
  [
    ...Object.keys(import.meta.glob("/src/**/*.{ts,tsx}")),
    ...Object.keys(import.meta.glob("/docs/**/*.md")),
  ].map((path) => path.slice(1)),
);

describe("bundled firmware rules", () => {
  it("loads, validates and has one rule per id", () => {
    expect(knownRules.length).toBeGreaterThan(0);
    expect(new Set(knownRules.map((rule) => rule.id)).size).toBe(knownRules.length);
  });

  it("backs every rule with recorded cases", () => {
    const caseIds = new Set(knownCases.map((entry) => entry.id));
    for (const rule of knownRules) {
      for (const caseId of rule.validatedCases) expect(caseIds.has(caseId)).toBe(true);
    }
  });

  it("points every rule at code, tests and documentation that exist", () => {
    for (const rule of knownRules) {
      for (const path of [...rule.implementation, ...rule.tests, ...(rule.documentation ?? [])]) {
        expect(repositoryFiles.has(path), `${rule.id}: ${path} does not exist`).toBe(true);
      }
    }
  });

  it("never lets a multi-sample rule rest on fewer than two cases", () => {
    for (const rule of knownRules.filter((entry) => entry.evidence === "multi-sample")) {
      expect(rule.validatedCases.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("lists the rules that rest on a single case, so a lone observation is not mistaken for a rule", () => {
    const warnings = ruleWarnings(knownRules);
    for (const warning of warnings) console.warn(warning);
    // Not a failure: a pattern starts from one case. The list is printed by
    // `npm run cases:check` and must name only rules that really have one.
    for (const warning of warnings) {
      expect(knownRules.some((rule) => warning.includes(rule.id) && rule.validatedCases.length < 2)).toBe(true);
    }
  });

  it("fails loudly on an invalid, misplaced or dangling rule", () => {
    const rule = knownRules[0];
    const place = `./rules/${rule.id}.json`;

    expect(() => loadRules({ [place]: rule }, knownCases)).not.toThrow();
    expect(() => loadRules({ "./rules/bad.json": { id: "x" } }, knownCases)).toThrow(/Invalid firmware rule \.\/rules\/bad\.json/);
    expect(() => loadRules({ "./rules/renamed.json": rule }, knownCases)).toThrow(/misplaced: expected \.\/rules\/AMI-/);
    expect(() => loadRules({ [place]: rule }, [])).toThrow(/not a recorded case/);
    expect(() => loadRules({ [place]: rule, "./rules/other.json": rule }, knownCases)).toThrow(/Duplicate rule id/);
  });
});
