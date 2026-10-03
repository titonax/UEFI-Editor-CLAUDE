import { describe, expect, it } from "vitest";
import { compareFingerprints, matchCases, minimumComparedFields } from "./caseMatcher";
import { fingerprintFromCase, fingerprintFromEntry } from "./fingerprint";
import type { FirmwareCase } from "./schema";
import type { CorpusRunEntry } from "../components/scripts/corpusDashboard";

function makeCase(hex: string, overrides: Partial<FirmwareCase> = {}): FirmwareCase {
  return {
    schemaVersion: 1,
    id: `ami-${hex.repeat(8)}`,
    sha256: hex.repeat(64),
    size: 1024,
    names: [`${hex}.bin`],
    vendorFamily: "ami-aptio",
    container: "intel-flash",
    generation: "unresolved",
    generationEvidence: "unresolved",
    features: { firmwareVolumes: 12, ffs2Files: 12, ffs3Files: 0, directSetupFiles: 0 },
    blockers: [],
    source: "test",
    ...overrides,
  };
}

describe("compareFingerprints", () => {
  it("compares only the fields both sides know", () => {
    const result = compareFingerprints(
      { container: "intel-flash", forms: 4 },
      { container: "intel-flash", firmwareVolumes: 12 },
    );
    expect(result.compared).toBe(1);
    expect(result.agreeing).toEqual(["container"]);
    expect(result.similarity).toBe(1);
  });

  it("lists the fields that disagree", () => {
    const result = compareFingerprints(
      { container: "intel-flash", firmwareVolumes: 12, ffs3Files: 0 },
      { container: "vendor-image", firmwareVolumes: 12, ffs3Files: 0 },
    );
    expect(result.differing).toEqual(["container"]);
    expect(result.agreeing).toEqual(["firmwareVolumes", "ffs3Files"]);
    expect(result.similarity).toBeCloseTo(2 / 3);
  });

  it("scores 0 when nothing is comparable", () => {
    expect(compareFingerprints({ forms: 1 }, { refs: 1 })).toMatchObject({ similarity: 0, compared: 0 });
  });
});

describe("matchCases", () => {
  const a = makeCase("a");
  const b = makeCase("b", { container: "vendor-image" });
  const c = makeCase("c", { features: { firmwareVolumes: 3, ffs2Files: 3, ffs3Files: 0, directSetupFiles: 1 } });
  const subject = fingerprintFromCase(a);

  it("finds the exact case by SHA-256, ignoring letter case", () => {
    const match = matchCases({ sha256: a.sha256.toUpperCase(), fingerprint: {} }, [a, b, c]);
    expect(match.exact).toBe(a);
  });

  it("returns no exact case for an unknown image", () => {
    expect(matchCases({ sha256: "f".repeat(64), fingerprint: subject }, [a, b, c]).exact).toBeUndefined();
  });

  it("never lists the exact case among the similar ones, and orders by similarity", () => {
    const match = matchCases({ sha256: a.sha256, fingerprint: subject }, [a, b, c]);
    expect(match.similar.map((entry) => entry.case.id)).not.toContain(a.id);
    const ids = match.similar.map((entry) => entry.case.id);
    expect(ids).toEqual([b.id, c.id]);
    expect(match.similar[0].similarity).toBeGreaterThan(match.similar[1].similarity);
  });

  it("drops cases with too few comparable fields instead of reporting a hollow 100%", () => {
    const thin = matchCases({ fingerprint: { container: "intel-flash" } }, [a, b, c]);
    expect(thin.similar).toEqual([]);
    expect(minimumComparedFields).toBeGreaterThan(1);
  });

  it("honours the limit", () => {
    expect(matchCases({ fingerprint: subject }, [a, b, c], { limit: 1 }).similar).toHaveLength(1);
  });
});

describe("fingerprintFromEntry", () => {
  const entry: CorpusRunEntry = {
    fileName: "board.bin",
    size: 100,
    sha256: "d".repeat(64),
    status: "partial",
    container: "intel-flash",
    generation: { generation: "unresolved", confidence: "unresolved", conflict: false },
    contextCount: 1,
    reconstructionBlockers: [],
    stages: [],
    vendorGuess: { family: "ami-aptio", label: "AMI Aptio", evidence: [] },
  };

  it("reshapes the corpus runner's own result without inventing fields", () => {
    expect(fingerprintFromEntry(entry)).toEqual({
      container: "intel-flash",
      vendorFamily: "ami-aptio",
      generation: "unresolved",
      contextCount: 1,
    });
  });

  it("treats an unknown container or vendor as unknown rather than as a value to match on", () => {
    const fingerprint = fingerprintFromEntry({
      ...entry,
      container: "unknown",
      vendorGuess: { family: "unknown", label: "?", evidence: [] },
    });
    expect(fingerprint.container).toBeUndefined();
    expect(fingerprint.vendorFamily).toBeUndefined();
  });
});
