import type { FirmwareCase, ValidationResult } from "./schema";

// A rule is a generalisation the editor relies on, as opposed to a case,
// which is one observed image. It is only recorded together with the cases
// that back it, the code that applies it and the tests that pin it, so a
// pattern seen on one image cannot quietly become a rule.
//
// Rules are a register, not an engine: no parser consults them. They exist so
// the project can say what it generalises, from which evidence, and see which
// generalisations rest on a single case.

export const ruleSchemaVersion = 1;

// How strongly the evidence backs the rule.
//   single-sample        one recorded case; a candidate, flagged by check
//   multi-sample         several recorded cases, never fewer than two
//   externally-confirmed backed by knowledge from outside this editor (the
//                        vendor, AMIBCP, a datasheet); needs documentation
export type RuleEvidence = "single-sample" | "multi-sample" | "externally-confirmed";
export const ruleEvidenceLevels: readonly RuleEvidence[] = [
  "single-sample",
  "multi-sample",
  "externally-confirmed",
];

export interface FirmwareRule {
  schemaVersion: typeof ruleSchemaVersion;
  // "<AREA>-<TOPIC>-<NNN>", for example AMI-HUB-001.
  id: string;
  description: string;
  evidence: RuleEvidence;
  // Cases that must back the rule for its evidence level to hold.
  minimumCases: number;
  // Ids of recorded cases (see schema.ts) that exhibit the rule.
  validatedCases: string[];
  // Repository-relative paths of the code that applies the rule.
  implementation: string[];
  // Repository-relative paths of the tests that pin it.
  tests: string[];
  documentation?: string[];
  notes?: string[];
}

const maxText = 200;
const idPattern = /^[A-Z]+-[A-Z]+-\d{3}$/;
const caseIdPattern = /^[a-z0-9-]+-[0-9a-f]{8}$/;
const topLevelKeys = new Set([
  "schemaVersion",
  "id",
  "description",
  "evidence",
  "minimumCases",
  "validatedCases",
  "implementation",
  "tests",
  "documentation",
  "notes",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isShortText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxText;
}

function isRepositoryPath(value: unknown): value is string {
  return (
    isShortText(value) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === ".." || part === "" || part === ".")
  );
}

function stringList(
  value: unknown,
  label: string,
  errors: string[],
  options: { minimum: number; valid: (entry: unknown) => boolean; message: string },
): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return [];
  }
  if (value.length < options.minimum) {
    errors.push(`${label} needs at least ${String(options.minimum)} entr${options.minimum === 1 ? "y" : "ies"}.`);
  }
  const entries: string[] = [];
  for (const entry of value) {
    if (!options.valid(entry)) {
      errors.push(`${label}: ${options.message}`);
      return entries;
    }
    entries.push(entry as string);
  }
  return entries;
}

// Strict structural validation of one rule: unknown keys are rejected, every
// enum is checked, text is short and the evidence level is consistent with the
// number of cases behind it. It checks shape and internal consistency, not
// that the cases exist (see findRuleProblems) or that the files do.
export function validateFirmwareRule(value: unknown): ValidationResult<FirmwareRule> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["A rule must be an object."] };

  for (const key of Object.keys(value)) {
    if (!topLevelKeys.has(key)) errors.push(`Unknown field "${key}".`);
  }
  if (value.schemaVersion !== ruleSchemaVersion) {
    errors.push(`schemaVersion must be ${String(ruleSchemaVersion)}.`);
  }
  if (typeof value.id !== "string" || !idPattern.test(value.id)) {
    errors.push('id must look like "AREA-TOPIC-001".');
  }
  if (!isShortText(value.description)) errors.push("description must be short, non-empty text.");
  const evidenceKnown =
    typeof value.evidence === "string" && (ruleEvidenceLevels as readonly string[]).includes(value.evidence);
  if (!evidenceKnown) errors.push("evidence is not a known evidence level.");
  const minimumValid =
    typeof value.minimumCases === "number" && Number.isInteger(value.minimumCases) && value.minimumCases >= 1;
  if (!minimumValid) errors.push("minimumCases must be a positive whole number.");

  const validated = stringList(value.validatedCases, "validatedCases", errors, {
    minimum: 1,
    valid: (entry) => typeof entry === "string" && caseIdPattern.test(entry),
    message: "every entry must be a case id such as ami-56430f2f.",
  });
  if (new Set(validated).size !== validated.length) errors.push("validatedCases has a repeated case id.");

  stringList(value.implementation, "implementation", errors, {
    minimum: 1,
    valid: isRepositoryPath,
    message: "every path must be repository-relative.",
  });
  stringList(value.tests, "tests", errors, {
    minimum: 1,
    valid: isRepositoryPath,
    message: "every path must be repository-relative.",
  });
  let documentation: string[] = [];
  if (value.documentation !== undefined) {
    documentation = stringList(value.documentation, "documentation", errors, {
      minimum: 0,
      valid: isRepositoryPath,
      message: "every path must be repository-relative.",
    });
  }
  if (value.notes !== undefined) {
    stringList(value.notes, "notes", errors, {
      minimum: 0,
      valid: isShortText,
      message: `every entry must be non-empty text of at most ${String(maxText)} characters.`,
    });
  }

  if (evidenceKnown && minimumValid) {
    const minimum = value.minimumCases as number;
    if (value.evidence === "multi-sample") {
      if (minimum < 2) errors.push("A multi-sample rule needs minimumCases of at least 2.");
      if (validated.length < Math.max(minimum, 2)) {
        errors.push(
          `A multi-sample rule needs at least ${String(Math.max(minimum, 2))} validated cases; it has ${String(validated.length)}.`,
        );
      }
    } else if (value.evidence === "single-sample") {
      if (validated.length !== 1) errors.push("A single-sample rule is backed by exactly one case.");
    } else if (documentation.length === 0) {
      errors.push("An externally-confirmed rule needs documentation naming the outside source.");
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as unknown as FirmwareRule };
}

// Cross-checks a collection of rules against the recorded cases: one rule per
// id, and every validated case must actually be a recorded case.
export function findRuleProblems(
  rules: readonly FirmwareRule[],
  cases: readonly Pick<FirmwareCase, "id">[],
): string[] {
  const problems: string[] = [];
  const caseIds = new Set(cases.map((entry) => entry.id));
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) problems.push(`Duplicate rule id ${rule.id}.`);
    seen.add(rule.id);
    for (const caseId of rule.validatedCases) {
      if (!caseIds.has(caseId)) {
        problems.push(`Rule ${rule.id} names ${caseId}, which is not a recorded case.`);
      }
    }
  }
  return problems;
}

// Rules that rest on a single recorded case. Not an error: it is how a
// pattern starts. It is listed so a generalisation made from one image stays
// visible until a second, independent case backs it.
export function ruleWarnings(rules: readonly FirmwareRule[]): string[] {
  return rules
    .filter((rule) => rule.validatedCases.length < 2)
    .map(
      (rule) =>
        `Rule ${rule.id} rests on a single case (${rule.validatedCases.join(", ")}); do not generalise it further until another independent case backs it.`,
    );
}
