import { describe, expect, it } from "vitest";
import {
  inspectSingleFormSetNavigation,
  refreshSingleFormSetNavigation,
  singleFormSetHubMenu,
} from "./singleFormSetNavigation";
import type { Data, Form, Menu, RefPrompt } from "./types";

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
    expect(report.reason).toContain("AMITSE corroborates 9 of them and contains 3 registered non-tab pages");
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
