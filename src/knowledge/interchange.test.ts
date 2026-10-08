import { describe, expect, it } from "vitest";
import interchange from "../../docs/knowledge-interchange.md?raw";
import { contentFields, genericFields, minimumComparedFields } from "./caseMatcher";
import { similarThreshold } from "./corpusKnowledge";
import { fingerprintFields } from "./fingerprint";
import { ruleEvidenceLevels } from "./ruleSchema";
import {
  caseSchemaVersion,
  caseStageIds,
  caseStageStatuses,
  confidences,
  containers,
  generations,
  vendorFamilies,
} from "./schema";

// docs/knowledge-interchange.md documents this fork's format and how it maps
// onto the GPT fork's, which keeps its own different format. It must say exactly
// what the code does, and it must not claim an agreement that does not exist.
// Every list in it is compared with the code, both ways.
const text: string = interchange;

function listed(name: string): string[] {
  const line = text.split("\n").find((one) => one.startsWith(`- \`${name}\`:`));
  expect(line, `a list line for ${name}`).toBeDefined();
  return [...(line ?? "").slice(line?.indexOf(":")).matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

describe("docs/knowledge-interchange.md", () => {
  it("lists exactly the vocabularies the validator accepts", () => {
    expect(listed("vendorFamily")).toEqual([...vendorFamilies]);
    expect(listed("container")).toEqual([...containers]);
    expect(listed("generation")).toEqual([...generations]);
    expect(listed("generationEvidence")).toEqual([...confidences]);
    expect(listed("stages")).toEqual([...caseStageIds]);
    expect(listed("stage status")).toEqual([...caseStageStatuses]);
    expect(listed("rule evidence")).toEqual([...ruleEvidenceLevels]);
  });

  it("lists exactly the content fields that may differ between similar images", () => {
    expect(listed("content fields")).toEqual([...contentFields]);
  });

  it("lists exactly the generic fields that cannot make two images similar on their own", () => {
    expect(listed("generic fields")).toEqual([...genericFields]);
  });

  it("lists exactly the fingerprint fields, in comparison order", () => {
    expect(listed("fingerprint")).toEqual([...fingerprintFields]);
  });

  it("states the schema version and the similarity thresholds the code uses", () => {
    expect(text).toContain(`schemaVersion\` is ${String(caseSchemaVersion)}`);
    expect(text).toContain(`similarity ≥ ${String(similarThreshold)}`);
    expect(text).toContain(`at least ${String(minimumComparedFields)} comparable fields`);
  });

  it("does not claim the other fork has adopted this format", () => {
    expect(text).toContain("has not adopted this page");
    expect(text).not.toMatch(/both forks (agree|share)/i);
    expect(text).not.toMatch(/must share/i);
  });

  it("maps every fingerprint field onto the other fork, or says there is no counterpart", () => {
    const section = /\n## Field correspondence\n([\s\S]*?)(?=\n## )/.exec(text)?.[1] ?? "";
    expect(section, "a Field correspondence section").not.toBe("");
    const rows = section
      .split("\n")
      .filter((line) => /^\| `[A-Za-z0-9]+` \|/.test(line) && line.split("|").length === 5)
      .map((line) => line.split("|").map((cell) => cell.trim()));
    const mapped = rows.filter((row) => (fingerprintFields as readonly string[]).includes(row[1].replace(/`/g, "")));

    expect(mapped.map((row) => row[1].replace(/`/g, ""))).toEqual([...fingerprintFields]);
    for (const row of mapped) expect(row[2], `${row[1]} needs a counterpart or an em dash`).not.toBe("");
  });
});
