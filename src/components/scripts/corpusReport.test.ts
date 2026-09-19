import { describe, expect, it } from "vitest";
import { buildCorpusReport, reportNavigationDetected, summarizeCorpusReports } from "./corpusReport";
import { parseData } from "./ifrParser";
import { buildFixtureFiles } from "./testFixtures";
import type { Data, RefPrompt } from "./types";

const GUID = "CCCCCCCC-1111-2222-3333-444444444444";

// A minimal same-hub inventory: Setup is the hub, Advanced is a live direct
// tab, and Chipset is a vendor-hidden tab parked inside a constant-true
// SuppressIf scope that is itself a direct child of the hub - the exact
// shape the real X870/Z890 corpus boards have (see tabVisibility.ts and
// docs/ami/single-formset-ifr-navigation.md). No byte offsets need to be
// realistic here: buildCorpusReport never touches raw bytes, only the
// declarative Data model analyzeTabVisibilityToggle itself reads.
function sameHubData(): Data {
  const refAdvanced: RefPrompt = {
    name: "Advanced",
    description: "",
    type: "Ref",
    questionId: "0x0001",
    varStoreId: "0x0001",
    formId: "0x2",
    formIdOffset: "0x1D",
    pageId: null,
    accessLevel: null,
    failsafe: null,
    optimal: null,
    offsets: null,
    sctOffset: "0x10",
  };
  const refChipset: RefPrompt = {
    name: "Chipset",
    description: "",
    type: "Ref",
    questionId: "0x0002",
    varStoreId: "0x0001",
    formId: "0x3",
    formIdOffset: "0x63",
    pageId: null,
    accessLevel: null,
    failsafe: null,
    optimal: null,
    offsets: null,
    sctOffset: "0x55",
    conditions: ["0x50"],
    suppressIf: ["0x50"],
  };

  return {
    firmwareFamily: "aptio-v",
    menu: [{ name: "Setup", formId: "0x1", offset: null, formSetGuid: GUID, source: "ifr-hub" }],
    forms: [
      {
        name: "Setup",
        type: "Form",
        formId: "0x1",
        formSetGuid: GUID,
        referencedIn: [],
        children: [refAdvanced, refChipset],
        endOffset: "0x100",
      },
      {
        name: "Advanced",
        type: "Form",
        formId: "0x2",
        formSetGuid: GUID,
        referencedIn: ["0x1"],
        children: [],
        endOffset: "0x110",
      },
      {
        name: "Chipset",
        type: "Form",
        formId: "0x3",
        formSetGuid: GUID,
        referencedIn: ["0x1"],
        children: [],
        endOffset: "0x120",
      },
    ],
    varStores: [],
    suppressions: [
      {
        offset: "0x50",
        active: true,
        start: "0x50",
        end: "0x60",
        kind: "SuppressIf",
        constant: true,
        source: "constant",
        expression: "True",
        varStoreNames: [],
        formSetGuid: GUID,
      },
    ],
    version: "test",
    hashes: { setupTxt: "", setupSct: "", amitseSct: "", setupdataBin: "", offsetChecksum: "" },
    singleFormSetNavigation: {
      status: "detected",
      mechanism: "single-formset-ifr-hub",
      confidence: "ifr-only",
      reason: "test fixture",
      formSetGuid: GUID,
      hubFormId: "0x1",
      hubName: "Setup",
      pages: [
        {
          name: "Setup",
          formId: "0x1",
          formSetGuid: GUID,
          role: "hub",
          registeredInAmitse: false,
          registrationOffsets: [],
          parentFormIds: [],
        },
        {
          name: "Advanced",
          formId: "0x2",
          formSetGuid: GUID,
          role: "direct-tab",
          registeredInAmitse: false,
          registrationOffsets: [],
          ifrReferenceOffset: "0x10",
          parentFormIds: ["0x1"],
        },
        {
          name: "Chipset",
          formId: "0x3",
          formSetGuid: GUID,
          role: "suppressed-tab",
          registeredInAmitse: false,
          registrationOffsets: [],
          suppressionOffset: "0x50",
          parentFormIds: ["0x1"],
        },
      ],
    },
  };
}

// Most older Aptio IV reference boards never have a single-FormSet IFR hub
// at all - they gate navigation through the multi-FormSet AMITSE root byte
// vector instead, so singleFormSetNavigation is absent/not-applicable while
// rootVisibility.status is "detected". This is the exact shape that made
// the corpus runner misreport 14/15 real boards as "Partial": it only ever
// checked report.navigation.status.
function rootVectorOnlyData(): Data {
  const data = sameHubData();
  data.singleFormSetNavigation = undefined;
  data.rootVisibility = {
    status: "detected",
    mechanism: "setup-pe32-root-byte-vector",
    confidence: "corroborated",
    reason: "test fixture",
    entries: [
      {
        rootIndex: 0,
        name: "Setup",
        formId: "0x1",
        formSetGuid: GUID,
        value: 1,
        visible: true,
        bufferOffset: 0x200,
      },
    ],
  };
  return data;
}

describe("reportNavigationDetected", () => {
  it("is true when only the root-visibility vector is detected and the single-FormSet hub is not applicable", () => {
    const report = buildCorpusReport(rootVectorOnlyData(), "root-vector-board");

    expect(report.navigation.status).not.toBe("detected");
    expect(report.rootVisibility?.status).toBe("detected");
    expect(reportNavigationDetected(report)).toBe(true);
  });

  it("is true when only the single-FormSet hub is detected", () => {
    const report = buildCorpusReport(sameHubData(), "same-hub-board");

    expect(reportNavigationDetected(report)).toBe(true);
  });

  it("is false when neither mechanism is detected", async () => {
    const data = await parseData(await buildFixtureFiles());

    const report = buildCorpusReport(data, "fixture");

    expect(reportNavigationDetected(report)).toBe(false);
  });
});

describe("buildCorpusReport", () => {
  it("reports counts and a not-applicable navigation status for a sample with no single-FormSet hub", async () => {
    const data = await parseData(await buildFixtureFiles());

    const report = buildCorpusReport(data, "fixture");

    expect(report.label).toBe("fixture");
    expect(report.firmwareFamily).toBe(data.firmwareFamily);
    expect(report.counts.forms).toBe(data.forms.length);
    expect(report.navigation.status).not.toBe("detected");
    expect(report.tabOperations).toEqual([]);
  });

  it("reports Hide/Show availability and reasons for every page in a detected single-FormSet inventory", () => {
    const data = sameHubData();

    const report = buildCorpusReport(data, "same-hub-board");

    expect(report.navigation).toMatchObject({
      status: "detected",
      mechanism: "single-formset-ifr-hub",
      hubName: "Setup",
      directTabs: 1,
      suppressedTabs: 1,
    });
    expect(report.tabOperations).toHaveLength(3);

    const hub = report.tabOperations.find((op) => op.role === "hub");
    expect(hub?.hide.available).toBe(false);
    expect(hub?.show.available).toBe(false);

    const advanced = report.tabOperations.find((op) => op.name === "Advanced");
    expect(advanced?.hide).toEqual({
      available: true,
      reason: 'Will park this tab inside the existing SuppressIf scope in "Setup".',
    });
    expect(advanced?.show.available).toBe(false);

    const chipset = report.tabOperations.find((op) => op.name === "Chipset");
    expect(chipset?.hide.available).toBe(false);
    expect(chipset?.show).toEqual({
      available: true,
      reason: 'Will restore this tab to the navigation hub "Setup".',
    });
  });
});

describe("summarizeCorpusReports", () => {
  it("renders one row per report with a header", () => {
    const report = buildCorpusReport(sameHubData(), "same-hub-board");

    const summary = summarizeCorpusReports([report]);

    const lines = summary.split("\n");
    expect(lines[0]).toContain("label");
    expect(lines[1]).toContain("same-hub-board");
    expect(lines[1]).toContain("1/1");
  });
});
