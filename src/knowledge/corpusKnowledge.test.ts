import { describe, expect, it } from "vitest";
import { classifyEntry, knowledgeBreakdown, noveltyReasons, similarThreshold } from "./corpusKnowledge";
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

describe("why an image is similar or new", () => {
  const farAway = (overrides: Partial<CorpusRunEntry> = {}) =>
    entry({
      container: "vendor-image",
      volumes: { firmwareVolumes: 3, ffs2Volumes: 0, ffs3Volumes: 3, directSetupFiles: 1 },
      ...overrides,
    });

  const withHii = (forms: number): Partial<CorpusRunEntry> => ({
    report: {
      label: "board.bin",
      firmwareFamily: "ami-aptio",
      counts: { formSets: 1, forms, refs: 10, conditions: 0 },
      navigation: {
        status: "detected",
        mechanism: "single-formset-hub",
        directTabs: 1,
        suppressedTabs: 0,
        descendants: 0,
        registeredOnly: 0,
      },
      tabOperations: [],
    },
  });
  const recorded: FirmwareCase = {
    ...known,
    features: { ...known.features, formSets: 1, forms: 205, refs: 10, navigation: "single-formset-hub" },
  };

  it("lists what a similar image shares with its case and where it differs, with both values", () => {
    const verdict = classifyEntry(entry(withHii(229)), [recorded]);

    expect(verdict.kind).toBe("similar");
    if (verdict.kind !== "similar") return;
    expect(verdict.differing).toEqual([{ field: "forms", image: 229, recorded: 205 }]);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.agreeing).toEqual(
      expect.arrayContaining(["container", "vendorFamily", "generation", "firmwareVolumes", "ffs2Volumes", "directSetupFiles"]),
    );
  });

  it("lets the content counts differ between revisions of the same kind of image", () => {
    const verdict = classifyEntry(entry({ ...withHii(300), contextCount: 1 }), [
      { ...recorded, features: { ...recorded.features, refs: 99 } },
    ]);

    // 9 of 11 comparable fields agree (82%): the threshold still applies.
    expect(verdict.kind).toBe("similar");
    if (verdict.kind === "similar") expect(verdict.differing.map((one) => one.field).sort()).toEqual(["forms", "refs"]);
  });

  it("does not call an image similar when a structural field differs, however high the score", () => {
    // 7 of 8 comparable fields agree (0.88), but the Setup is visible in the
    // outer scan here and hidden in the recorded image's compressed volume.
    const verdict = classifyEntry(
      entry({ ...withHii(205), volumes: { firmwareVolumes: 12, ffs2Volumes: 12, ffs3Volumes: 0, directSetupFiles: 1 } }),
      [recorded],
    );

    expect(verdict.kind).toBe("novel");
    if (verdict.kind !== "novel") return;
    expect(verdict.nearest?.similarity).toBeGreaterThanOrEqual(similarThreshold);
    expect(verdict.nearest?.blocking).toEqual(["directSetupFiles"]);
    expect(verdict.nearest?.differing).toEqual([{ field: "directSetupFiles", image: 1, recorded: 0 }]);
  });

  it("prefers a case it can be similar to over a closer-scoring case it differs from structurally", () => {
    const structurallyOff: FirmwareCase = {
      ...recorded,
      id: "ami-cccccccc",
      sha256: "c".repeat(64),
      features: { ...recorded.features, directSetupFiles: 1 },
    };
    const sameKind: FirmwareCase = {
      ...recorded,
      id: "ami-dddddddd",
      sha256: "d".repeat(64),
      features: { ...recorded.features, forms: 100 },
    };
    const verdict = classifyEntry(entry(withHii(205)), [structurallyOff, sameKind]);

    expect(verdict.kind).toBe("similar");
    if (verdict.kind === "similar") expect(verdict.case.id).toBe("ami-dddddddd");
  });

  it("names the closest case, and what differs from it, for a new image", () => {
    const verdict = classifyEntry(farAway(), [known]);

    expect(verdict.kind).toBe("novel");
    if (verdict.kind !== "novel") return;
    expect(verdict.nearest?.case.id).toBe("ami-aaaaaaaa");
    expect(verdict.nearest?.similarity).toBeLessThan(similarThreshold);
    expect(verdict.nearest?.blocking).toEqual(expect.arrayContaining(["container", "firmwareVolumes"]));
    expect(verdict.nearest?.differing).toEqual(
      expect.arrayContaining([
        { field: "container", image: "vendor-image", recorded: "intel-flash" },
        { field: "firmwareVolumes", image: 3, recorded: 12 },
      ]),
    );
    expect(verdict.nearest?.agreeing).toEqual(expect.arrayContaining(["vendorFamily"]));
  });

  it("says there is nothing to compare with when too little was observed, instead of inventing a closest case", () => {
    const verdict = classifyEntry(
      entry({ volumes: undefined, generation: undefined, vendorGuess: undefined, contextCount: 0 }),
      [known],
    );

    expect(verdict).toEqual({ kind: "novel" });
  });

  it("is quiet for an exact case", () => {
    const verdict = classifyEntry(entry({ sha256: known.sha256 }), [known]);
    expect(verdict.kind).toBe("exact");
  });
});

describe("noveltyReasons", () => {
  const farAway = (sha: string, overrides: Partial<CorpusRunEntry> = {}) =>
    entry({
      sha256: sha,
      container: "vendor-image",
      volumes: { firmwareVolumes: 3, ffs2Volumes: 0, ffs3Volumes: 3, directSetupFiles: 1 },
      ...overrides,
    });

  it("tallies which fields keep new images apart from the closest recorded case", () => {
    const entries = [
      farAway("1".repeat(64)),
      farAway("2".repeat(64), { container: "intel-flash" }),
      entry({ sha256: known.sha256 }),
      entry({ sha256: "3".repeat(64) }),
    ];

    const reasons = noveltyReasons(entries, [known]);

    // Two new images differ in firmwareVolumes/ffs2Volumes/ffs3Volumes/
    // directSetupFiles; only the first also differs in container.
    expect(reasons.byField).toContainEqual({ field: "firmwareVolumes", cases: 2 });
    expect(reasons.byField).toContainEqual({ field: "container", cases: 1 });
    expect(reasons.byField.find((reason) => reason.field === "vendorFamily")).toBeUndefined();
    expect(reasons.noComparableCase).toBe(0);
  });

  it("counts new images that had nothing comparable apart", () => {
    const bare = entry({
      sha256: "4".repeat(64),
      volumes: undefined,
      generation: undefined,
      vendorGuess: undefined,
      contextCount: 0,
    });

    const reasons = noveltyReasons([bare], [known]);

    expect(reasons).toEqual({ byField: [], noComparableCase: 1 });
  });

  it("orders the most common reason first and ignores images that are known or similar", () => {
    const entries = [farAway("5".repeat(64)), farAway("6".repeat(64)), farAway("7".repeat(64), { container: "intel-flash" })];

    const reasons = noveltyReasons(entries, [known]);

    expect(reasons.byField[0].cases).toBeGreaterThanOrEqual(reasons.byField[reasons.byField.length - 1].cases);
    expect(noveltyReasons([entry({ sha256: known.sha256 }), entry()], [known])).toEqual({ byField: [], noComparableCase: 0 });
  });
});
