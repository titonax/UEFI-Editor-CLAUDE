import { describe, expect, it } from "vitest";
import { findRuleProblems, ruleWarnings, validateFirmwareRule, type FirmwareRule } from "./ruleSchema";
import type { FirmwareCase } from "./schema";

function validRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "AMI-HUB-001",
    description: "A single FormSet whose entry Form fans out into the tabs is the navigation hub.",
    evidence: "multi-sample",
    minimumCases: 2,
    validatedCases: ["ami-aaaaaaaa", "ami-bbbbbbbb"],
    implementation: ["src/components/scripts/singleFormSetNavigation.ts"],
    tests: ["src/components/scripts/singleFormSetNavigation.test.ts"],
    ...overrides,
  };
}

function errorsFor(value: unknown) {
  const result = validateFirmwareRule(value);
  return result.ok ? [] : result.errors;
}

describe("validateFirmwareRule", () => {
  it("accepts a well-formed multi-sample rule", () => {
    expect(validateFirmwareRule(validRule()).ok).toBe(true);
  });

  it("accepts documentation and notes", () => {
    const result = validateFirmwareRule(
      validRule({ documentation: ["docs/ami/single-formset-ifr-navigation.md"], notes: ["Seen on two boards"] }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects anything that is not an object", () => {
    expect(errorsFor(null)).not.toHaveLength(0);
    expect(errorsFor("rule")).not.toHaveLength(0);
  });

  it("rejects unknown fields", () => {
    expect(errorsFor(validRule({ bytes: "DEADBEEF" })).join(" ")).toMatch(/Unknown field "bytes"/);
  });

  it("requires an id of the form AREA-TOPIC-NNN", () => {
    for (const id of ["ami-hub-001", "AMI-HUB-1", "HUB-001", "AMI HUB 001", ""]) {
      expect(errorsFor(validRule({ id })).join(" ")).toMatch(/id must look like/);
    }
  });

  it("rejects values outside the evidence vocabulary", () => {
    expect(errorsFor(validRule({ evidence: "obvious" })).join(" ")).toMatch(/evidence/);
  });

  it("requires a positive whole minimumCases", () => {
    expect(errorsFor(validRule({ minimumCases: 0 })).join(" ")).toMatch(/minimumCases/);
    expect(errorsFor(validRule({ minimumCases: 1.5 })).join(" ")).toMatch(/minimumCases/);
  });

  it("never lets a multi-sample rule rest on fewer than two cases", () => {
    expect(errorsFor(validRule({ minimumCases: 1 })).join(" ")).toMatch(/at least 2/);
    expect(errorsFor(validRule({ validatedCases: ["ami-aaaaaaaa"] })).join(" ")).toMatch(/needs at least 2/);
  });

  it("holds a single-sample rule to exactly one case", () => {
    const single = validRule({ evidence: "single-sample", minimumCases: 1, validatedCases: ["ami-aaaaaaaa"] });
    expect(validateFirmwareRule(single).ok).toBe(true);
    expect(errorsFor({ ...single, validatedCases: ["ami-aaaaaaaa", "ami-bbbbbbbb"] }).join(" ")).toMatch(
      /single-sample/,
    );
  });

  it("requires documentation for externally confirmed evidence", () => {
    const confirmed = validRule({ evidence: "externally-confirmed", minimumCases: 1, validatedCases: ["ami-aaaaaaaa"] });
    expect(errorsFor(confirmed).join(" ")).toMatch(/documentation/);
    expect(validateFirmwareRule({ ...confirmed, documentation: ["docs/ami/setupdata-control-flags.md"] }).ok).toBe(
      true,
    );
  });

  it("rejects repeated or malformed case ids", () => {
    expect(errorsFor(validRule({ validatedCases: ["ami-aaaaaaaa", "ami-aaaaaaaa"] })).join(" ")).toMatch(/repeated/);
    expect(errorsFor(validRule({ validatedCases: ["ami-aaaaaaaa", "not a case"] })).join(" ")).toMatch(/case id/);
  });

  it("requires at least one implementation and one test, as repository-relative paths", () => {
    expect(errorsFor(validRule({ implementation: [] })).join(" ")).toMatch(/implementation/);
    expect(errorsFor(validRule({ tests: [] })).join(" ")).toMatch(/tests/);
    expect(errorsFor(validRule({ tests: ["/etc/passwd"] })).join(" ")).toMatch(/repository-relative/);
    expect(errorsFor(validRule({ tests: ["../outside.test.ts"] })).join(" ")).toMatch(/repository-relative/);
  });

  it("rejects text long enough to hide binary data", () => {
    expect(errorsFor(validRule({ description: "A".repeat(201) })).join(" ")).toMatch(/description/);
    expect(errorsFor(validRule({ notes: ["A".repeat(201)] })).join(" ")).toMatch(/notes/);
  });
});

describe("findRuleProblems", () => {
  const rule = validRule() as unknown as FirmwareRule;
  const cases = [{ id: "ami-aaaaaaaa" }, { id: "ami-bbbbbbbb" }] as FirmwareCase[];

  it("reports nothing for a rule whose cases all exist", () => {
    expect(findRuleProblems([rule], cases)).toEqual([]);
  });

  it("reports a validated case that is not a recorded case", () => {
    const problems = findRuleProblems([{ ...rule, validatedCases: ["ami-aaaaaaaa", "ami-cccccccc"] }], cases);
    expect(problems.join(" ")).toMatch(/AMI-HUB-001.*ami-cccccccc/);
  });

  it("reports a repeated rule id", () => {
    expect(findRuleProblems([rule, rule], cases).join(" ")).toMatch(/Duplicate rule id AMI-HUB-001/);
  });
});

describe("ruleWarnings", () => {
  it("flags a rule that rests on a single case", () => {
    const single = validRule({ evidence: "single-sample", minimumCases: 1, validatedCases: ["ami-aaaaaaaa"] });
    const warnings = ruleWarnings([single as unknown as FirmwareRule]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/AMI-HUB-001.*single case/);
  });

  it("is quiet about a rule with several cases", () => {
    expect(ruleWarnings([validRule() as unknown as FirmwareRule])).toEqual([]);
  });
});
