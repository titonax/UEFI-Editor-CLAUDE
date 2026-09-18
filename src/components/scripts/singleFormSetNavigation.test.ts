import { describe, expect, it } from "vitest";
import {
  inspectSingleFormSetNavigation,
  refreshSingleFormSetNavigation,
  singleFormSetHubMenu,
} from "./singleFormSetNavigation";
import type { Data, Form, Menu, RefPrompt, Suppression } from "./types";

const GUID = "7B59104A-C00D-4158-87FF-F04D6396A915";

function makeRef(overrides: Partial<RefPrompt> = {}): RefPrompt {
  return {
    name: "Go to page",
    description: "",
    type: "Ref",
    questionId: "0x0001",
    varStoreId: "0x0001",
    formId: "0x2",
    formIdOffset: "0x0",
    pageId: null,
    accessLevel: null,
    failsafe: null,
    optimal: null,
    offsets: null,
    sctOffset: "0x0",
    ...overrides,
  };
}

function makeForm(overrides: Partial<Form> = {}): Form {
  return {
    name: "A form",
    type: "Form",
    formId: "0x1",
    formSetGuid: GUID,
    referencedIn: [],
    children: [],
    endOffset: "0x0",
    ...overrides,
  };
}

function formSetRoot(formId = "0x2710", formSetGuid = GUID): Menu[number] {
  return { name: "Setup", formId, offset: null, formSetGuid, source: "formset" };
}

// The ROG STRIX Z390-E layout: a Setup hub with nine direct tabs, Security
// registered in AMITSE but reached only through Main, and a detached Exit
// that AMITSE registers although no Ref leads to it.
function z390Graph() {
  const tabs = [
    ["My Favorites", "0x2712", "0x67BC1"],
    ["Main", "0x2713", "0x67BD0"],
    ["Ai Tweaker", "0x2714", "0x67BDF"],
    ["Advanced", "0x2715", "0x67BEE"],
    ["Monitor", "0x2716", "0x67BFD"],
    ["Chipset", "0x2717", "0x67C0C"],
    ["Boot", "0x2718", "0x67C1B"],
    ["Tool", "0x2719", "0x67C2A"],
    ["Exit", "0x271A", "0x67C39"],
  ] as const;
  const hub = makeForm({
    name: "Setup",
    formId: "0x2710",
    children: tabs.map(([name, formId, sctOffset], index) =>
      makeRef({ name, formId, sctOffset, questionId: `0x${(0x100 + index).toString(16)}` }),
    ),
  });
  const tabForms = tabs.map(([name, formId]) =>
    makeForm({ name, formId, referencedIn: [hub.formId] }),
  );
  const main = tabForms[1];
  main.children.push(makeRef({ name: "Security", formId: "0x27E5", questionId: "0x200" }));
  const security = makeForm({ name: "Security", formId: "0x27E5", referencedIn: [main.formId] });
  const detachedExit = makeForm({ name: "Exit", formId: "0x271B" });
  const forms = [hub, ...tabForms, security, detachedExit];
  const registrations: Menu = forms.map((form, index) => ({
    name: form.name,
    formId: form.formId,
    formSetGuid: GUID,
    offset: `0x${(0x193000 + index * 0x20).toString(16).toUpperCase()}`,
    source: "amitse",
  }));
  return { tabs, forms, registrations };
}

describe("inspectSingleFormSetNavigation", () => {
  it("reproduces the ROG STRIX Z390-E tab graph", () => {
    const { tabs, forms, registrations } = z390Graph();

    const report = inspectSingleFormSetNavigation([formSetRoot()], forms, registrations);

    expect(report).toMatchObject({
      status: "detected",
      confidence: "corroborated",
      hubFormId: "0x2710",
      hubName: "Setup",
    });
    expect(
      report.pages.filter((page) => page.role === "direct-tab").map((page) => page.formId),
    ).toEqual(tabs.map(([, formId]) => formId));
    expect(report.pages[1]).toMatchObject({
      name: "My Favorites",
      ifrReferenceOffset: "0x67BC1",
      registeredInAmitse: true,
      parentFormIds: ["0x2710"],
    });
    expect(report.pages.find((page) => page.formId === "0x27E5")).toMatchObject({
      role: "descendant",
      parentFormIds: ["0x2713"],
    });
    expect(report.pages.find((page) => page.formId === "0x271B")).toMatchObject({
      role: "registered-only",
      parentFormIds: [],
    });
    expect(report.reason).toContain("9 direct Refs define the current top-level tabs");
    expect(report.reason).toContain(
      "AMITSE corroborates 9 of the current tabs and contains 3 other registered pages",
    );
  });

  it("collapses repeated AMITSE registrations of one page into its offsets", () => {
    const { forms, registrations } = z390Graph();
    const duplicated = [...registrations, { ...registrations[1], offset: "0x1FFF00" }];

    const report = inspectSingleFormSetNavigation([formSetRoot()], forms, duplicated);

    expect(report.pages[1].registrationOffsets).toEqual(["0x193020", "0x1FFF00"]);
  });

  it("is ifr-only when AMITSE does not corroborate every tab", () => {
    const { forms, registrations } = z390Graph();

    const report = inspectSingleFormSetNavigation([formSetRoot()], forms, registrations.slice(2));

    expect(report.confidence).toBe("ifr-only");
    expect(report.pages[1].registeredInAmitse).toBe(false);
  });

  it("does not apply to more than one FormSet entry", () => {
    const { forms, registrations } = z390Graph();

    const report = inspectSingleFormSetNavigation(
      [formSetRoot(), formSetRoot("0x1", "AAAAAAAA-0000-0000-0000-000000000000")],
      forms,
      registrations,
    );

    expect(report).toMatchObject({ status: "not-applicable", pages: [] });
  });

  it("stays unresolved when the entry Form has fewer than two direct Refs", () => {
    const hub = makeForm({ name: "Setup", formId: "0x1", children: [makeRef({ formId: "0x2" })] });
    const page = makeForm({ formId: "0x2", referencedIn: ["0x1"] });

    const report = inspectSingleFormSetNavigation([formSetRoot("0x1")], [hub, page], []);

    expect(report.status).toBe("unresolved");
    expect(report.reason).toContain("multi-page direct Ref fan-out");
  });

  it("stays unresolved when the entry Form is missing from the graph", () => {
    const report = inspectSingleFormSetNavigation([formSetRoot("0x9")], [makeForm()], []);

    expect(report).toMatchObject({ status: "unresolved", formSetGuid: GUID });
  });

  it("is ambiguous when a direct Ref has no target or targets are duplicated", () => {
    const hub = makeForm({
      name: "Setup",
      formId: "0x1",
      children: [makeRef({ formId: "0x2" }), makeRef({ formId: "0x3" })],
    });
    const page = makeForm({ formId: "0x2", referencedIn: ["0x1"] });

    expect(inspectSingleFormSetNavigation([formSetRoot("0x1")], [hub, page], [])).toMatchObject({
      status: "ambiguous",
      reason: "Direct hub Ref 0x3 has no target Form.",
    });

    hub.children = [makeRef({ formId: "0x2" }), makeRef({ formId: "0x2", questionId: "0x2" })];
    expect(inspectSingleFormSetNavigation([formSetRoot("0x1")], [hub, page], [])).toMatchObject({
      status: "ambiguous",
      reason: "The FormSet entry contains duplicate direct Refs to the same Form, so tab identity is ambiguous.",
    });
  });

  it("ignores direct Refs that leave the FormSet", () => {
    const hub = makeForm({
      name: "Setup",
      formId: "0x1",
      children: [
        makeRef({ formId: "0x2" }),
        makeRef({ formId: "0x3", targetFormSetGuid: "AAAAAAAA-0000-0000-0000-000000000000" }),
        makeRef({ formId: "0x4" }),
      ],
    });
    const forms = [
      hub,
      makeForm({ formId: "0x2", referencedIn: ["0x1"] }),
      makeForm({ formId: "0x4", referencedIn: ["0x1"] }),
    ];

    const report = inspectSingleFormSetNavigation([formSetRoot("0x1")], forms, []);

    expect(report.status).toBe("detected");
    expect(report.pages.map((page) => page.formId)).toEqual(["0x1", "0x2", "0x4"]);
  });

  it("classifies a page reachable only through a constant-true SuppressIf as a suppressed tab", () => {
    const { forms, registrations } = z390Graph();
    const hub = forms[0];
    // "Boot" (0x2718) is where the tab-visibility toggle parked "Tool"'s
    // Ref - an existing, reused SuppressIf scope elsewhere in the FormSet,
    // not Tool's own Form.
    const boot = forms.find((form) => form.formId === "0x2718");
    if (!boot) throw new Error("Boot form missing from fixture");
    const toolIndex = hub.children.findIndex(
      (child) => child.type === "Ref" && child.formId === "0x2719",
    );
    const [toolRef] = hub.children.splice(toolIndex, 1) as [RefPrompt];
    toolRef.conditions = ["0x99000"];
    toolRef.suppressIf = ["0x99000"];
    toolRef.hiddenByTabToggle = "0x99000";
    boot.children.push(toolRef);
    const suppressions: Suppression[] = [
      { offset: "0x99000", active: true, start: "0x99000", end: "0x99010", kind: "SuppressIf", constant: true },
    ];

    const report = inspectSingleFormSetNavigation(
      [formSetRoot()],
      forms,
      registrations,
      undefined,
      suppressions,
    );

    expect(report.pages.filter((page) => page.role === "direct-tab")).toHaveLength(8);
    expect(report.pages.find((page) => page.formId === "0x2719")).toMatchObject({
      role: "suppressed-tab",
      suppressionOffset: "0x99000",
      parentFormIds: ["0x2718"],
    });
    expect(report.reason).toContain(
      "and 1 hub Ref sits inside a constant-true SuppressIf scope",
    );
  });

  it("classifies a hub-owned suppressed Ref as a suppressed tab even when its target isn't registered in AMITSE at all", () => {
    // The real gap this closes: a vendor already ships a hub child hidden
    // behind its own constant-true SuppressIf (e.g. "Chipset"/"Security" on
    // several ASRock/Gigabyte X870 and Z890 boards), and that page is not
    // independently registered in AMITSE - the hub Ref is itself first-
    // party evidence and must not depend on registration to be surfaced.
    const hub = makeForm({
      name: "Setup",
      formId: "0x1",
      children: [
        makeRef({ formId: "0x2", questionId: "0x1" }),
        makeRef({ formId: "0x3", questionId: "0x2" }),
        makeRef({
          name: "Chipset",
          formId: "0x4",
          questionId: "0x3",
          sctOffset: "0x50",
          conditions: ["0x60"],
          suppressIf: ["0x60"],
        }),
      ],
    });
    const forms = [
      hub,
      makeForm({ formId: "0x2", referencedIn: ["0x1"] }),
      makeForm({ formId: "0x3", referencedIn: ["0x1"] }),
      makeForm({ name: "Chipset", formId: "0x4" }),
    ];
    const suppressions: Suppression[] = [
      { offset: "0x60", active: true, start: "0x60", end: "0x70", kind: "SuppressIf", constant: true },
    ];

    const report = inspectSingleFormSetNavigation(
      [formSetRoot("0x1")],
      forms,
      [],
      undefined,
      suppressions,
    );

    expect(report.status).toBe("detected");
    expect(report.pages.filter((page) => page.role === "direct-tab")).toHaveLength(2);
    expect(report.pages.find((page) => page.formId === "0x4")).toMatchObject({
      role: "suppressed-tab",
      suppressionOffset: "0x60",
      registeredInAmitse: false,
      parentFormIds: ["0x1"],
    });
    expect(report.reason).toContain("and 1 hub Ref sits inside a constant-true SuppressIf scope");
  });

  it("leaves an ambiguous hub-owned suppression unclassified when two hub Refs suppress the same target", () => {
    const hub = makeForm({
      name: "Setup",
      formId: "0x1",
      children: [
        makeRef({ formId: "0x2", questionId: "0x1" }),
        makeRef({ formId: "0x3", questionId: "0x2" }),
        makeRef({
          formId: "0x4",
          questionId: "0x3",
          sctOffset: "0x50",
          conditions: ["0x60"],
          suppressIf: ["0x60"],
        }),
        makeRef({
          formId: "0x4",
          questionId: "0x4",
          sctOffset: "0x80",
          conditions: ["0x90"],
          suppressIf: ["0x90"],
        }),
      ],
    });
    const forms = [
      hub,
      makeForm({ formId: "0x2", referencedIn: ["0x1"] }),
      makeForm({ formId: "0x3", referencedIn: ["0x1"] }),
      makeForm({ formId: "0x4" }),
    ];
    const suppressions: Suppression[] = [
      { offset: "0x60", active: true, start: "0x60", end: "0x70", kind: "SuppressIf", constant: true },
      { offset: "0x90", active: true, start: "0x90", end: "0xA0", kind: "SuppressIf", constant: true },
    ];

    const report = inspectSingleFormSetNavigation(
      [formSetRoot("0x1")],
      forms,
      [],
      undefined,
      suppressions,
    );

    expect(report.pages.find((page) => page.formId === "0x4")).toBeUndefined();
  });

  it("falls back to registered-only when two Refs suppress the same target", () => {
    const { forms, registrations } = z390Graph();
    const hub = forms[0];
    const boot = forms.find((form) => form.formId === "0x2718");
    const chipset = forms.find((form) => form.formId === "0x2717");
    if (!boot || !chipset) throw new Error("Fixture form missing");
    const toolIndex = hub.children.findIndex(
      (child) => child.type === "Ref" && child.formId === "0x2719",
    );
    const [toolRef] = hub.children.splice(toolIndex, 1) as [RefPrompt];
    toolRef.conditions = ["0x99000"];
    toolRef.suppressIf = ["0x99000"];
    boot.children.push(toolRef);
    // A second, independent Ref to the same target, parked under a
    // different constant-true scope - "the" suppressed reference is now
    // ambiguous, so this must not be promoted to "suppressed-tab".
    chipset.children.push(
      makeRef({
        name: "Tool",
        formId: "0x2719",
        questionId: "0x300",
        sctOffset: "0x99200",
        conditions: ["0x99100"],
        suppressIf: ["0x99100"],
      }),
    );
    const suppressions: Suppression[] = [
      { offset: "0x99000", active: true, start: "0x99000", end: "0x99010", kind: "SuppressIf", constant: true },
      { offset: "0x99100", active: true, start: "0x99100", end: "0x99110", kind: "SuppressIf", constant: true },
    ];

    const report = inspectSingleFormSetNavigation(
      [formSetRoot()],
      forms,
      registrations,
      undefined,
      suppressions,
    );

    expect(report.pages.find((page) => page.formId === "0x2719")).toMatchObject({
      role: "registered-only",
    });
  });
});

describe("singleFormSetHubMenu", () => {
  it("makes the hub the only menu root of a detected layout", () => {
    const { forms, registrations } = z390Graph();
    const report = inspectSingleFormSetNavigation([formSetRoot()], forms, registrations);

    expect(singleFormSetHubMenu(report)).toEqual([
      { name: "Setup", formId: "0x2710", offset: null, formSetGuid: GUID, source: "ifr-hub" },
    ]);
  });

  it("is empty for anything not detected", () => {
    expect(singleFormSetHubMenu(inspectSingleFormSetNavigation([], [], []))).toEqual([]);
  });
});

describe("refreshSingleFormSetNavigation", () => {
  function hubData(): Data {
    const { forms, registrations } = z390Graph();
    const report = inspectSingleFormSetNavigation([formSetRoot()], forms, registrations);
    return {
      firmwareFamily: "aptio-v",
      menu: singleFormSetHubMenu(report),
      formSetRoots: [formSetRoot()],
      forms,
      varStores: [],
      suppressions: [],
      singleFormSetNavigation: report,
      version: "test",
      hashes: { setupTxt: "", setupSct: "", amitseSct: "", setupdataBin: "", offsetChecksum: "" },
    };
  }

  it("re-classifies a demoted tab from the graph while keeping the AMITSE evidence", () => {
    const data = hubData();
    // Move the "Tool" Ref out of the hub under Main.
    const hub = data.forms[0];
    const [tool] = hub.children.splice(7, 1);
    data.forms[2].children.push(tool);

    refreshSingleFormSetNavigation(data);

    const report = data.singleFormSetNavigation;
    expect(report?.status).toBe("detected");
    expect(report?.pages.filter((page) => page.role === "direct-tab")).toHaveLength(8);
    expect(report?.pages.find((page) => page.formId === "0x2719")).toMatchObject({
      role: "descendant",
      registeredInAmitse: true,
      registrationOffsets: ["0x193100"],
      parentFormIds: ["0x2713"],
    });
    expect(data.menu).toEqual([
      { name: "Setup", formId: "0x2710", offset: null, formSetGuid: GUID, source: "ifr-hub" },
    ]);
  });

  it("keeps a proven hub even when only one direct tab is left", () => {
    const data = hubData();
    const hub = data.forms[0];
    data.forms[2].children.push(...hub.children.splice(1));

    refreshSingleFormSetNavigation(data);

    expect(data.singleFormSetNavigation?.status).toBe("detected");
    expect(
      data.singleFormSetNavigation?.pages.filter((page) => page.role === "direct-tab"),
    ).toHaveLength(1);
  });

  it("promotes a descendant whose Ref moved into the hub", () => {
    const data = hubData();
    const main = data.forms[2];
    const [security] = main.children.splice(0, 1);
    data.forms[0].children.push(security);

    refreshSingleFormSetNavigation(data);

    expect(data.singleFormSetNavigation?.pages.find((page) => page.formId === "0x27E5")).toMatchObject({
      role: "direct-tab",
      parentFormIds: ["0x2710"],
    });
  });

  it("rebuilds from imported evidence without formSetRoots", () => {
    const evidence = hubData().singleFormSetNavigation;
    const imported: Data = { ...hubData(), menu: [] };
    delete imported.formSetRoots;
    delete imported.singleFormSetNavigation;

    refreshSingleFormSetNavigation(imported, evidence);

    expect(imported).toMatchObject({
      singleFormSetNavigation: { status: "detected", hubFormId: "0x2710" },
      menu: [{ source: "ifr-hub", formId: "0x2710" }],
    });
  });

  it("keeps a newly-hidden tab at its known position instead of moving it to the end", () => {
    const data = hubData();
    const hub = data.forms[0];
    const boot = data.forms.find((form) => form.formId === "0x2718");
    if (!boot) throw new Error("Boot form missing from fixture");
    // Hide "Ai Tweaker" (the 3rd tab) by parking its Ref inside an
    // existing constant-true SuppressIf scope elsewhere - exactly what
    // applyTabVisibilityToggle does, done here by hand to isolate ordering.
    const aiTweakerIndex = hub.children.findIndex(
      (child) => child.type === "Ref" && child.formId === "0x2714",
    );
    const [aiTweakerRef] = hub.children.splice(aiTweakerIndex, 1) as [RefPrompt];
    aiTweakerRef.conditions = ["0x99000"];
    aiTweakerRef.suppressIf = ["0x99000"];
    aiTweakerRef.hiddenByTabToggle = "0x99000";
    boot.children.push(aiTweakerRef);
    data.suppressions.push({
      offset: "0x99000",
      active: true,
      start: "0x99000",
      end: "0x99010",
      kind: "SuppressIf",
      constant: true,
    });

    refreshSingleFormSetNavigation(data);

    const report = data.singleFormSetNavigation;
    // Without order preservation, a fresh classification would put the
    // now-suppressed "Ai Tweaker" last, after every other registered page -
    // it stays 3rd, right where it always was.
    expect(report?.pages.map((page) => page.formId)).toEqual([
      "0x2710",
      "0x2712",
      "0x2713",
      "0x2714",
      "0x2715",
      "0x2716",
      "0x2717",
      "0x2718",
      "0x2719",
      "0x271A",
      "0x27E5",
      "0x271B",
    ]);
    expect(report?.pages.find((page) => page.formId === "0x2714")).toMatchObject({
      role: "suppressed-tab",
      suppressionOffset: "0x99000",
      parentFormIds: ["0x2718"],
    });
  });

  it("leaves other layouts alone", () => {
    const data = hubData();
    data.singleFormSetNavigation = {
      status: "not-applicable",
      mechanism: "single-formset-ifr-hub",
      confidence: "unresolved",
      reason: "several FormSets",
      pages: [],
    };
    data.menu = [{ name: "Main", formId: "0x400", offset: null, source: "setupdata" }];

    refreshSingleFormSetNavigation(data);

    expect(data.menu[0].source).toBe("setupdata");
  });
});
