import { describe, expect, it } from "vitest";
import {
  buildCorpusDashboard,
  cohortBreakdown,
  distinctEntries,
  entryContainerLabel,
  entryFamilyLabel,
  entryGenerationLabel,
  entryIfrFormatLabel,
  entryManufacturerLabel,
  failureCodeBreakdown,
  firstRecognitionBlocker,
  recognitionBreakdown,
  stageBreakdown,
  type CorpusRunEntry,
} from "./corpusDashboard";

function stage(id: CorpusRunEntry["stages"][number]["id"], status: CorpusRunEntry["stages"][number]["status"]) {
  return { id, status, detail: "" };
}

function recognizedEntry(overrides: Partial<CorpusRunEntry> = {}): CorpusRunEntry {
  return {
    fileName: "recognized.bin",
    size: 100,
    sha256: "aaaa",
    status: "recognized",
    container: "intel-flash",
    generation: { generation: "aptio-v", confidence: "probable", conflict: false },
    contextCount: 1,
    reconstructionComplete: true,
    reconstructionBlockers: [],
    stages: [
      stage("preflight", "passed"),
      stage("extraction", "passed"),
      stage("hii", "passed"),
      stage("navigation", "passed"),
      stage("editability", "passed"),
      stage("reconstruction", "blocked"),
    ],
    report: {
      label: "recognized.bin",
      firmwareFamily: "aptio-v",
      counts: { formSets: 1, forms: 1, refs: 1, conditions: 0 },
      navigation: {
        status: "detected",
        directTabs: 1,
        suppressedTabs: 0,
        descendants: 0,
        registeredOnly: 0,
      },
      tabOperations: [
        {
          name: "Advanced",
          formId: "0x2",
          role: "direct-tab",
          registeredInAmitse: false,
          hide: { available: true, reason: "" },
          show: { available: false, reason: "" },
        },
      ],
    },
    brand: {
      brand: "ASUS",
      basis: "firmware-marker",
      signals: [],
      documentedSamples: 5,
      observedGenerations: [],
      observedContainers: [],
      observedLayouts: [],
      navigationPrior: [],
      navigationOutcome: "matches-prior",
    },
    ...overrides,
  };
}

function partialEntry(overrides: Partial<CorpusRunEntry> = {}): CorpusRunEntry {
  const base = recognizedEntry();
  return {
    ...base,
    fileName: "partial.bin",
    sha256: "bbbb",
    status: "partial",
    stages: [
      stage("preflight", "passed"),
      stage("extraction", "passed"),
      stage("hii", "passed"),
      stage("navigation", "warning"),
      stage("editability", "warning"),
      stage("reconstruction", "blocked"),
    ],
    report: {
      ...base.report,
      navigation: { status: "not-applicable", directTabs: 0, suppressedTabs: 0, descendants: 0, registeredOnly: 0 },
      tabOperations: [],
    },
    ...overrides,
  } as CorpusRunEntry;
}

function unsupportedEntry(overrides: Partial<CorpusRunEntry> = {}): CorpusRunEntry {
  return {
    fileName: "unsupported.bin",
    size: 50,
    sha256: "cccc",
    status: "unsupported",
    container: "vendor-image",
    contextCount: 0,
    reconstructionBlockers: [],
    stages: [
      stage("preflight", "passed"),
      stage("extraction", "not-run"),
      stage("hii", "not-run"),
      stage("navigation", "not-run"),
      stage("editability", "not-run"),
      stage("reconstruction", "not-run"),
    ],
    failureMessage: "Setup FFS was not found after recursive decompression.",
    vendorGuess: { family: "insyde", label: "Insyde H2O", evidence: ["InsydeH2O"] },
    brand: {
      brand: null,
      basis: "unknown",
      signals: [],
      documentedSamples: 0,
      observedGenerations: [],
      observedContainers: [],
      observedLayouts: [],
      navigationPrior: [],
      navigationOutcome: "unmeasured",
    },
    ...overrides,
  };
}

function failedEntry(overrides: Partial<CorpusRunEntry> = {}): CorpusRunEntry {
  return {
    fileName: "failed.bin",
    size: 10,
    sha256: "",
    status: "failed",
    contextCount: 0,
    reconstructionBlockers: [],
    stages: [
      stage("preflight", "not-run"),
      stage("extraction", "not-run"),
      stage("hii", "not-run"),
      stage("navigation", "not-run"),
      stage("editability", "not-run"),
      stage("reconstruction", "not-run"),
    ],
    failureMessage: "Exceeds the 512 MiB safety limit.",
    ...overrides,
  };
}

describe("distinctEntries", () => {
  it("keeps only the first occurrence of each SHA-256", () => {
    const a = recognizedEntry();
    const duplicate = recognizedEntry({ fileName: "duplicate.bin" });

    expect(distinctEntries([a, duplicate])).toEqual([a]);
  });

  it("never merges two entries that both lack a hash", () => {
    const first = failedEntry();
    const second = failedEntry({ fileName: "failed2.bin" });

    expect(distinctEntries([first, second])).toHaveLength(2);
  });
});

describe("firstRecognitionBlocker", () => {
  it("is 'reading' when the file was never even hashed", () => {
    expect(firstRecognitionBlocker(failedEntry())).toBe("reading");
  });

  it("is 'extraction' when preflight passed but extraction never did", () => {
    expect(firstRecognitionBlocker(unsupportedEntry())).toBe("extraction");
  });

  it("is 'navigation' for a partial entry, since that stage pushes warning, not passed", () => {
    expect(firstRecognitionBlocker(partialEntry())).toBe("navigation");
  });

  it("is 'none' once every stage through navigation passed", () => {
    expect(firstRecognitionBlocker(recognizedEntry())).toBe("none");
  });
});

describe("stageBreakdown", () => {
  it("only counts a stage as eligible once its prerequisite stage passed", () => {
    const breakdown = stageBreakdown([unsupportedEntry()]);

    const preflight = breakdown.find((stage) => stage.id === "preflight");
    const extraction = breakdown.find((stage) => stage.id === "extraction");
    const hii = breakdown.find((stage) => stage.id === "hii");
    expect(preflight).toMatchObject({ eligible: 1, passed: 1 });
    expect(extraction).toMatchObject({ eligible: 1, notRun: 1 });
    // hii was never eligible: extraction (its prerequisite) never passed.
    expect(hii).toMatchObject({ eligible: 0 });
  });
});

describe("cohortBreakdown", () => {
  it("groups entries by label and measures the same four capabilities per group", () => {
    const cohorts = cohortBreakdown(
      [recognizedEntry(), partialEntry(), unsupportedEntry()],
      entryFamilyLabel,
    );

    const ami = cohorts.find((cohort) => cohort.label === "AMI Aptio");
    expect(ami).toMatchObject({ cases: 2, extracted: 2, navigationResolved: 1, hiiEditable: 1 });
    const insyde = cohorts.find((cohort) => cohort.label === "Insyde H2O");
    expect(insyde).toMatchObject({ cases: 1, extracted: 0 });
  });
});

describe("entry label helpers", () => {
  it("labels a recognized/partial entry's IFR format as UEFI, and an unsupported one from its vendorGuess family", () => {
    expect(entryIfrFormatLabel(recognizedEntry())).toBe("UEFI");
    expect(entryIfrFormatLabel(unsupportedEntry())).toBe("Unknown");
    expect(
      entryIfrFormatLabel(
        unsupportedEntry({ vendorGuess: { family: "legacy-framework-hii", label: "x", evidence: [] } }),
      ),
    ).toBe("Framework");
  });

  it("labels manufacturer as Conflict or Unknown when no single brand won", () => {
    expect(entryManufacturerLabel(unsupportedEntry())).toBe("Unknown");
    expect(
      entryManufacturerLabel(
        unsupportedEntry({
          brand: {
            brand: null,
            basis: "conflict",
            signals: [],
            documentedSamples: 0,
            observedGenerations: [],
            observedContainers: [],
            observedLayouts: [],
            navigationPrior: [],
            navigationOutcome: "unmeasured",
          },
        }),
      ),
    ).toBe("Conflict");
  });

  it("labels container and generation directly from the entry", () => {
    expect(entryContainerLabel(recognizedEntry())).toBe("intel-flash");
    expect(entryContainerLabel(failedEntry())).toBe("unknown");
    expect(entryGenerationLabel(recognizedEntry())).toBe("aptio-v");
    expect(entryGenerationLabel(failedEntry())).toBe("unresolved");
  });
});

describe("recognitionBreakdown", () => {
  it("puts every entry into exactly one blocker category with its filename listed", () => {
    const breakdown = recognitionBreakdown([recognizedEntry(), unsupportedEntry(), failedEntry()]);

    expect(breakdown.find((entry) => entry.category === "none")).toMatchObject({
      cases: 1,
      fileNames: ["recognized.bin"],
    });
    expect(breakdown.find((entry) => entry.category === "extraction")).toMatchObject({
      cases: 1,
      fileNames: ["unsupported.bin"],
    });
    expect(breakdown.find((entry) => entry.category === "reading")).toMatchObject({
      cases: 1,
      fileNames: ["failed.bin"],
    });
  });
});

describe("failureCodeBreakdown", () => {
  it("classifies known failure messages into a small closed set of codes", () => {
    const breakdown = failureCodeBreakdown([unsupportedEntry(), failedEntry()]);

    expect(breakdown).toContainEqual(
      expect.objectContaining({ code: "NO_SETUP_FFS", stage: "extraction", cases: 1 }),
    );
    expect(breakdown).toContainEqual(
      expect.objectContaining({ code: "TOO_LARGE", stage: "reading", cases: 1 }),
    );
  });

  it("skips entries with no failure message", () => {
    expect(failureCodeBreakdown([recognizedEntry()])).toEqual([]);
  });
});

describe("buildCorpusDashboard", () => {
  it("aggregates distinct-case counts, stage/blocker/cohort breakdowns from a mixed run", () => {
    const entries = [recognizedEntry(), partialEntry(), unsupportedEntry(), failedEntry()];

    const dashboard = buildCorpusDashboard(entries, entries.length);

    expect(dashboard.selected).toBe(4);
    expect(dashboard.completed).toBe(4);
    expect(dashboard.uniqueCases).toBe(4);
    expect(dashboard.duplicateHashes).toBe(0);
    expect(dashboard.unhashedCases).toBe(1);
    // recognized/partial both inherit the "ASUS" brand fixture; only
    // unsupported (brand null) and failed (no brand at all) are unknown.
    expect(dashboard.unknownManufacturer).toBe(2);
    expect(dashboard.families.map((cohort) => cohort.label)).toContain("AMI Aptio");
    expect(dashboard.recognitionBlockers.reduce((total, entry) => total + entry.cases, 0)).toBe(4);
  });

  it("counts a duplicate-hash entry once for distinct-case purposes", () => {
    const entries = [recognizedEntry(), recognizedEntry({ fileName: "dup.bin" })];

    const dashboard = buildCorpusDashboard(entries);

    expect(dashboard.uniqueCases).toBe(1);
    expect(dashboard.duplicateHashes).toBe(1);
  });
});
