import { describe, expect, it } from "vitest";
import interchange from "../../docs/knowledge-interchange.md?raw";
import { minimumComparedFields } from "./caseMatcher";
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

// docs/knowledge-interchange.md is what another implementation of this
// project (the GPT fork) is aligned against, so it must say exactly what the
// code does. Every list in it is compared with the code, both ways.
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

  it("lists exactly the fingerprint fields, in comparison order", () => {
    expect(listed("fingerprint")).toEqual([...fingerprintFields]);
  });

  it("states the schema version and the similarity thresholds the code uses", () => {
    expect(text).toContain(`schemaVersion\` is ${String(caseSchemaVersion)}`);
    expect(text).toContain(`similarity ≥ ${String(similarThreshold)}`);
    expect(text).toContain(`at least ${String(minimumComparedFields)} comparable fields`);
  });
});
