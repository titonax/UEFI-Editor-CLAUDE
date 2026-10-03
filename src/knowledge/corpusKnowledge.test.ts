import { describe, expect, it } from "vitest";
import { classifyEntry, knowledgeBreakdown, similarThreshold } from "./corpusKnowledge";
import { fingerprintFromEntry } from "./fingerprint";
import type { FirmwareCase } from "./schema";
import type { CorpusRunEntry } from "../components/scripts/corpusDashboard";

const known: FirmwareCase = {
  schemaVersion: 1,
  id: "ami-aaaaaaaa",
  sha256: "a".repeat(64),
  size: 1024,
  names: ["known.bin"],
  vendorFamily: "ami-aptio",
  container: "intel-flash",
  generation: "unresolved",
  generationEvidence: "unresolved",
  features: { firmwareVolumes: 12, ffs2Volumes: 12, ffs3Volumes: 0, directSetupFiles: 0 },
  blockers: [],
  source: "test",
};

function entry(overrides: Partial<CorpusRunEntry> = {}): CorpusRunEntry {
  return {
    fileName: "board.bin",
    size: 1024,
    sha256: "b".repeat(64),
    status: "partial",
    container: "intel-flash",
    generation: { generation: "unresolved", confidence: "unresolved", conflict: false },
    contextCount: 1,
    reconstructionBlockers: [],
    stages: [],
    vendorGuess: { family: "ami-aptio", label: "AMI Aptio", evidence: [] },
    volumes: { firmwareVolumes: 12, ffs2Volumes: 12, ffs3Volumes: 0, directSetupFiles: 0 },
    ...overrides,
  };
}

describe("fingerprintFromEntry with preflight volume counts", () => {
  it("carries the volume counts the corpus runner measured", () => {
    expect(fingerprintFromEntry(entry())).toMatchObject({
      firmwareVolumes: 12,
      ffs2Volumes: 12,
      ffs3Volumes: 0,
      directSetupFiles: 0,
    });
  });

  it("leaves them unknown when the runner never reached preflight", () => {
    expect(fingerprintFromEntry(entry({ volumes: undefined })).firmwareVolumes).toBeUndefined();
  });
});

describe("classifyEntry", () => {
  it("is exact when the SHA-256 is a known case, whatever the structure says", () => {
    const verdict = classifyEntry(entry({ sha256: known.sha256, container: "vendor-image" }), [known]);
    expect(verdict).toMatchObject({ kind: "exact" });
    expect(verdict.kind === "exact" && verdict.case.id).toBe("ami-aaaaaaaa");
  });

  it("is similar when an unknown image structurally resembles a known case", () => {
    const verdict = classifyEntry(entry(), [known]);
    expect(verdict.kind).toBe("similar");
    if (verdict.kind === "similar") {
      expect(verdict.similarity).toBeGreaterThanOrEqual(similarThreshold);
      expect(verdict.case.id).toBe("ami-aaaaaaaa");
      expect(verdict.compared).toBeGreaterThanOrEqual(3);
    }
  });

  it("is novel when nothing resembles it closely enough", () => {
    const verdict = classifyEntry(
      entry({
        container: "vendor-image",
        volumes: { firmwareVolumes: 3, ffs2Volumes: 0, ffs3Volumes: 3, directSetupFiles: 1 },
      }),
      [known],
    );
    expect(verdict.kind).toBe("novel");
  });

  it("is novel, not a hollow match, when too little was observed to compare", () => {
    const verdict = classifyEntry(
      entry({ volumes: undefined, generation: undefined, vendorGuess: undefined, contextCount: 0 }),
      [known],
    );
    expect(verdict.kind).toBe("novel");
  });

  it("is novel against an empty knowledge base", () => {
    expect(classifyEntry(entry(), []).kind).toBe("novel");
  });
});

describe("knowledgeBreakdown", () => {
  it("counts exact, similar and novel entries", () => {
    const entries = [
      entry({ sha256: known.sha256 }),
      entry({ sha256: "c".repeat(64) }),
      entry({
        sha256: "d".repeat(64),
        container: "vendor-image",
        volumes: { firmwareVolumes: 3, ffs2Volumes: 0, ffs3Volumes: 3, directSetupFiles: 1 },
      }),
    ];
    expect(knowledgeBreakdown(entries, [known])).toEqual({ exact: 1, similar: 1, novel: 1 });
  });
});
