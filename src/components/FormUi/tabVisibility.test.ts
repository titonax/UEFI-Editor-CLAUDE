import { describe, expect, it } from "vitest";
import { buildMenuTree } from "../Navigation/menuTree";
import {
  inspectSingleFormSetNavigation,
  refreshSingleFormSetNavigation,
  singleFormSetHubMenu,
} from "../scripts/singleFormSetNavigation";
import type { AmiSingleFormSetPage, Data, Form, Menu, RefPrompt, Suppression } from "../scripts/types";
import { analyzeTabVisibilityToggle, applyTabVisibilityToggle } from "./tabVisibility";

const GUID = "7B59104A-C00D-4158-87FF-F04D6396A915";
const HUB_FORM_INDEX = 0;

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

// A Setup hub with three direct tabs (Main, Advanced, Boot) plus Chipset, a
// registered non-tab Form that already parks one Ref ("Legacy") inside an
// existing, active constant-true SuppressIf scope - a genuine, reusable
// "parking bin" the tab visibility toggle can hide a tab inside.
function hubGraph() {
  const hub = makeForm({
    name: "Setup",
    formId: "0x2711",
    children: [
      makeRef({ name: "Main", formId: "0x2714", sctOffset: "0x100", questionId: "0x1" }),
      makeRef({ name: "Advanced", formId: "0x2725", sctOffset: "0x110", questionId: "0x2" }),
      makeRef({ name: "Boot", formId: "0x271F", sctOffset: "0x120", questionId: "0x3" }),
    ],
    endOffset: "0x130",
  });
  const main = makeForm({ name: "Main", formId: "0x2714", referencedIn: ["0x2711"], endOffset: "0x140" });
  const advanced = makeForm({
    name: "Advanced",
    formId: "0x2725",
    referencedIn: ["0x2711"],
    endOffset: "0x150",
  });
  const boot = makeForm({ name: "Boot", formId: "0x271F", referencedIn: ["0x2711"], endOffset: "0x160" });
  // Chipset's own SuppressIf scope (0x170-0x190) already parks one Ref
  // ("Legacy") pristinely - a genuine, reusable parking bin elsewhere in
  // the FormSet, distinct from the same-hub scopes exercised below.
  const legacyTarget = makeForm({ name: "Legacy", formId: "0x2730", endOffset: "0x1B0" });
  const chipset = makeForm({
    name: "Chipset",
    formId: "0x2721",
    children: [
      makeRef({
        name: "Legacy",
        formId: "0x2730",
        sctOffset: "0x180",
        questionId: "0x4",
        conditions: ["0x170"],
        suppressIf: ["0x170"],
      }),
    ],
    endOffset: "0x1A0",
  });
  const forms = [hub, main, advanced, boot, chipset, legacyTarget];
  const suppressions: Suppression[] = [
    {
      offset: "0x170",
      active: true,
      start: "0x170",
      end: "0x190",
      kind: "SuppressIf",
      constant: true,
      formSetGuid: GUID,
    },
  ];
  const registrations: Menu = forms.map((form, index) => ({
    name: form.name,
    formId: form.formId,
    formSetGuid: GUID,
    offset: `0x${(0x300 + index * 0x20).toString(16).toUpperCase()}`,
    source: "amitse",
  }));
  const formSetRoots: Menu = [
    { name: "Setup", formId: "0x2711", offset: null, formSetGuid: GUID, source: "formset" },
  ];
  return { forms, suppressions, registrations, formSetRoots };
}

function hubData(): Data {
  const { forms, suppressions, registrations, formSetRoots } = hubGraph();
  const report = inspectSingleFormSetNavigation(
    formSetRoots,
    forms,
    registrations,
    undefined,
    suppressions,
  );
  return {
    firmwareFamily: "aptio-v",
    menu: singleFormSetHubMenu(report),
    formSetRoots,
    forms,
    varStores: [],
    suppressions,
    singleFormSetNavigation: report,
    version: "test",
    hashes: { setupTxt: "", setupSct: "", amitseSct: "", setupdataBin: "", offsetChecksum: "" },
  };
}

function findPage(data: Data, formId: string): AmiSingleFormSetPage {
  const page = data.singleFormSetNavigation?.pages.find((candidate) => candidate.formId === formId);
  if (!page) throw new Error(`Page ${formId} missing from the report`);
  return page;
}

// A Setup hub whose only constant-true SuppressIf scope is itself a direct
// child of the hub (a vendor-shipped "Chipset" tab already hidden that way,
// like several ASRock/Gigabyte X870 and Z890 boards) - no scope exists
// anywhere else in the FormSet, so Hide can only succeed by reusing this
// same-hub scope.
function sameHubGraph() {
  const hub = makeForm({
    name: "Setup",
    formId: "0x2711",
    children: [
      makeRef({ name: "Main", formId: "0x2714", sctOffset: "0x100", questionId: "0x1" }),
      makeRef({ name: "Advanced", formId: "0x2725", sctOffset: "0x110", questionId: "0x2" }),
      makeRef({
        name: "Chipset",
        formId: "0x2713",
        sctOffset: "0x130",
        questionId: "0x3",
        conditions: ["0x120"],
        suppressIf: ["0x120"],
      }),
    ],
    endOffset: "0x150",
  });
  const main = makeForm({ name: "Main", formId: "0x2714", referencedIn: ["0x2711"], endOffset: "0x160" });
  const advanced = makeForm({
    name: "Advanced",
    formId: "0x2725",
    referencedIn: ["0x2711"],
    endOffset: "0x170",
  });
  const chipsetTarget = makeForm({ name: "Chipset", formId: "0x2713", endOffset: "0x180" });
  const forms = [hub, main, advanced, chipsetTarget];
  const suppressions: Suppression[] = [
    {
      offset: "0x120",
      active: true,
      start: "0x120",
      end: "0x140",
      kind: "SuppressIf",
      constant: true,
      formSetGuid: GUID,
    },
  ];
  const registrations: Menu = forms.map((form, index) => ({
    name: form.name,
    formId: form.formId,
    formSetGuid: GUID,
    offset: `0x${(0x300 + index * 0x20).toString(16).toUpperCase()}`,
    source: "amitse",
  }));
  const formSetRoots: Menu = [
    { name: "Setup", formId: "0x2711", offset: null, formSetGuid: GUID, source: "formset" },
  ];
  return { forms, suppressions, registrations, formSetRoots };
}

function sameHubData(): Data {
  const { forms, suppressions, registrations, formSetRoots } = sameHubGraph();
  const report = inspectSingleFormSetNavigation(
    formSetRoots,
    forms,
    registrations,
    undefined,
    suppressions,
  );
  return {
    firmwareFamily: "aptio-v",
    menu: singleFormSetHubMenu(report),
    formSetRoots,
    forms,
    varStores: [],
    suppressions,
    singleFormSetNavigation: report,
    version: "test",
    hashes: { setupTxt: "", setupSct: "", amitseSct: "", setupdataBin: "", offsetChecksum: "" },
  };
}

describe("same-hub SuppressIf reuse", () => {
  it("finds a same-hub scope to reuse when nothing elsewhere in the FormSet qualifies", () => {
    const data = sameHubData();
    const advanced = findPage(data, "0x2725");

    const result = analyzeTabVisibilityToggle(
      data,
      buildMenuTree(data),
      advanced,
      "hide",
      HUB_FORM_INDEX,
    );

    expect(result).toMatchObject({ available: true, sourceFormIndex: 0, childIndex: 1 });
    expect(result.reason).toContain("Setup");
  });

  it("hides a tab into the hub's own SuppressIf scope and shows it back in order", () => {
    const data = sameHubData();
    const advanced = findPage(data, "0x2725");
    const hide = analyzeTabVisibilityToggle(data, buildMenuTree(data), advanced, "hide", HUB_FORM_INDEX);
    if (hide.sourceFormIndex === undefined || hide.childIndex === undefined) {
      throw new Error("Advanced tab did not resolve to a location");
    }

    applyTabVisibilityToggle(data, HUB_FORM_INDEX, hide.sourceFormIndex, hide.childIndex, "hide");

    const hub = data.forms[HUB_FORM_INDEX];
    // Same-hub Hide never leaves hub.children at all - it lands the parked
    // Ref at the array's own end, past Chipset, rather than moving it to a
    // different Form's children.
    expect(hub.children.map((child) => (child as RefPrompt).formId)).toEqual([
      "0x2714",
      "0x2713",
      "0x2725",
    ]);
    const parked = hub.children.find(
      (child) => child.type === "Ref" && child.formId === "0x2725",
    ) as RefPrompt | undefined;
    expect(parked).toMatchObject({ conditions: ["0x120"], suppressIf: ["0x120"] });
    expect(findPage(data, "0x2725")).toMatchObject({ role: "suppressed-tab", suppressionOffset: "0x120" });

    const suppressed = findPage(data, "0x2725");
    const show = analyzeTabVisibilityToggle(data, buildMenuTree(data), suppressed, "show", HUB_FORM_INDEX);
    expect(show.available).toBe(true);
    if (show.sourceFormIndex === undefined || show.childIndex === undefined) {
      throw new Error("Suppressed tab did not resolve to a location");
    }

    applyTabVisibilityToggle(data, HUB_FORM_INDEX, show.sourceFormIndex, show.childIndex, "show");

    // Chipset is still the only other tab, and it's suppressed - not a live
    // direct-tab neighbor orderPreservingIndex will anchor to - so Advanced
    // safely falls back to the hub's own end rather than guessing.
    expect(hub.children.map((child) => (child as RefPrompt).formId)).toEqual([
      "0x2714",
      "0x2713",
      "0x2725",
    ]);
    expect(findPage(data, "0x2725").role).toBe("direct-tab");
  });

  it("shows the vendor's own hub-owned suppressed tab back to its pristine position, not the hub's end", () => {
    // Regression fixture for the same-array index staleness Show must
    // correct for: Chipset sits BETWEEN two live tabs (Main, Boot) at its
    // own pristine position - never touched by Hide - so orderPreservingIndex
    // finds a real anchor (Boot) rather than falling back to the hub's end,
    // and the just-removed Chipset shifts every later index down by one
    // before that anchor's own current index is read.
    const hub = makeForm({
      name: "Setup",
      formId: "0x2711",
      children: [
        makeRef({ name: "Main", formId: "0x2714", sctOffset: "0x100", questionId: "0x1" }),
        makeRef({
          name: "Chipset",
          formId: "0x2713",
          sctOffset: "0x120",
          questionId: "0x2",
          conditions: ["0x110"],
          suppressIf: ["0x110"],
        }),
        makeRef({ name: "Boot", formId: "0x271F", sctOffset: "0x140", questionId: "0x3" }),
      ],
      endOffset: "0x150",
    });
    const main = makeForm({ name: "Main", formId: "0x2714", referencedIn: ["0x2711"], endOffset: "0x160" });
    const chipsetTarget = makeForm({ name: "Chipset", formId: "0x2713", endOffset: "0x170" });
    const boot = makeForm({ name: "Boot", formId: "0x271F", referencedIn: ["0x2711"], endOffset: "0x180" });
    const forms = [hub, main, chipsetTarget, boot];
    const suppressions: Suppression[] = [
      {
        offset: "0x110",
        active: true,
        start: "0x110",
        end: "0x130",
        kind: "SuppressIf",
        constant: true,
        formSetGuid: GUID,
      },
    ];
    const formSetRoots: Menu = [
      { name: "Setup", formId: "0x2711", offset: null, formSetGuid: GUID, source: "formset" },
    ];
    const report = inspectSingleFormSetNavigation(formSetRoots, forms, [], undefined, suppressions);
    const data: Data = {
      firmwareFamily: "aptio-v",
      menu: singleFormSetHubMenu(report),
      formSetRoots,
      forms,
      varStores: [],
      suppressions,
      singleFormSetNavigation: report,
      version: "test",
      hashes: { setupTxt: "", setupSct: "", amitseSct: "", setupdataBin: "", offsetChecksum: "" },
    };

    const chipset = findPage(data, "0x2713");
    expect(chipset.role).toBe("suppressed-tab");

    const show = analyzeTabVisibilityToggle(data, buildMenuTree(data), chipset, "show", HUB_FORM_INDEX);
    expect(show.available).toBe(true);
    if (show.sourceFormIndex === undefined || show.childIndex === undefined) {
      throw new Error("Chipset did not resolve to a location");
    }

    applyTabVisibilityToggle(data, HUB_FORM_INDEX, show.sourceFormIndex, show.childIndex, "show");

    expect(hub.children.map((child) => (child as RefPrompt).formId)).toEqual([
      "0x2714",
      "0x2713",
      "0x271F",
    ]);
    expect(findPage(data, "0x2713").role).toBe("direct-tab");
  });
});

describe("analyzeTabVisibilityToggle", () => {
  it("finds an existing constant-true SuppressIf scope to reuse for hiding a tab", () => {
    const data = hubData();
    const advanced = findPage(data, "0x2725");

    const result = analyzeTabVisibilityToggle(
      data,
      buildMenuTree(data),
      advanced,
      "hide",
      HUB_FORM_INDEX,
    );

    expect(result).toMatchObject({ available: true, sourceFormIndex: 0, childIndex: 1 });
    expect(result.reason).toContain("Chipset");
  });

  it("refuses to hide a tab that already carries its own hide condition", () => {
    const data = hubData();
    const mainRef = data.forms[HUB_FORM_INDEX].children[0];
    mainRef.conditions = ["0xABCD"];
    const main = findPage(data, "0x2714");

    const result = analyzeTabVisibilityToggle(data, buildMenuTree(data), main, "hide", HUB_FORM_INDEX);

    expect(result.available).toBe(false);
    expect(result.reason).toContain("use Move instead");
  });

  it("refuses to hide when no reusable constant-true SuppressIf scope exists", () => {
    const data = hubData();
    data.suppressions = [];
    const main = findPage(data, "0x2714");

    const result = analyzeTabVisibilityToggle(data, buildMenuTree(data), main, "hide", HUB_FORM_INDEX);

    expect(result.available).toBe(false);
    expect(result.reason).toContain("No existing constant-true SuppressIf scope");
  });

  it("refuses to show a page whose only Ref isn't parked by this toggle", () => {
    const data = hubData();
    const advanced = { ...findPage(data, "0x2725"), role: "suppressed-tab" as const };

    const result = analyzeTabVisibilityToggle(
      data,
      buildMenuTree(data),
      advanced,
      "show",
      HUB_FORM_INDEX,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toContain("isn't currently parked");
  });

  it("refuses to show a tab that would duplicate a live direct Ref on the hub", () => {
    const data = hubData();
    const hub = data.forms[HUB_FORM_INDEX];
    // Park a second Ref to Main's own target inside the Chipset scope by
    // hand, bypassing applyTabVisibilityToggle, so the hub still carries a
    // live direct Ref to 0x2714 at the same time - the ambiguous case
    // analyzeTabVisibilityToggle must reject regardless of how it arose.
    const chipset = data.forms.find((form) => form.formId === "0x2721");
    if (!chipset) throw new Error("Chipset form missing from fixture");
    const parkedDuplicate = makeRef({
      name: "Main",
      formId: "0x2714",
      sctOffset: "0x210",
      questionId: "0x5",
      conditions: ["0x170"],
      suppressIf: ["0x170"],
      hiddenByTabToggle: "0x170",
    });
    chipset.children.push(parkedDuplicate);
    const fakeSuppressedPage: AmiSingleFormSetPage = {
      name: "Main",
      formId: "0x2714",
      formSetGuid: GUID,
      role: "suppressed-tab",
      registeredInAmitse: true,
      registrationOffsets: [],
      ifrReferenceOffset: "0x210",
      suppressionOffset: "0x170",
      parentFormIds: ["0x2721"],
    };

    const result = analyzeTabVisibilityToggle(
      data,
      buildMenuTree(data),
      fakeSuppressedPage,
      "show",
      HUB_FORM_INDEX,
    );

    expect(hub.children).toHaveLength(3);
    expect(result.available).toBe(false);
    expect(result.reason).toContain("would duplicate it");
  });
});

describe("applyTabVisibilityToggle", () => {
  it("hides a tab into the reused SuppressIf scope, marking it and leaving the wrapper in place", () => {
    const data = hubData();
    const advanced = findPage(data, "0x2725");
    const { sourceFormIndex, childIndex } = analyzeTabVisibilityToggle(
      data,
      buildMenuTree(data),
      advanced,
      "hide",
      HUB_FORM_INDEX,
    );
    if (sourceFormIndex === undefined || childIndex === undefined) {
      throw new Error("Advanced tab did not resolve to a location");
    }

    applyTabVisibilityToggle(data, HUB_FORM_INDEX, sourceFormIndex, childIndex, "hide");

    const hub = data.forms[HUB_FORM_INDEX];
    expect(hub.children.map((child) => (child as RefPrompt).formId)).toEqual(["0x2714", "0x271F"]);
    const chipset = data.forms.find((form) => form.formId === "0x2721");
    if (!chipset) throw new Error("Chipset form missing from fixture");
    const parked = chipset.children.find(
      (child) => child.type === "Ref" && child.formId === "0x2725",
    ) as RefPrompt | undefined;
    expect(parked).toMatchObject({
      conditions: ["0x170"],
      suppressIf: ["0x170"],
      hiddenByTabToggle: "0x170",
    });
    expect(findPage(data, "0x2725")).toMatchObject({
      role: "suppressed-tab",
      suppressionOffset: "0x170",
    });
  });

  it("shows a hidden tab back on the hub, between the neighbors it used to sit between", () => {
    const data = hubData();
    const advanced = findPage(data, "0x2725");
    const hide = analyzeTabVisibilityToggle(data, buildMenuTree(data), advanced, "hide", HUB_FORM_INDEX);
    if (hide.sourceFormIndex === undefined || hide.childIndex === undefined) {
      throw new Error("Advanced tab did not resolve to a location");
    }
    applyTabVisibilityToggle(data, HUB_FORM_INDEX, hide.sourceFormIndex, hide.childIndex, "hide");

    const suppressed = findPage(data, "0x2725");
    expect(suppressed.role).toBe("suppressed-tab");
    const show = analyzeTabVisibilityToggle(
      data,
      buildMenuTree(data),
      suppressed,
      "show",
      HUB_FORM_INDEX,
    );
    expect(show.available).toBe(true);
    if (show.sourceFormIndex === undefined || show.childIndex === undefined) {
      throw new Error("Suppressed tab did not resolve to a location");
    }

    applyTabVisibilityToggle(data, HUB_FORM_INDEX, show.sourceFormIndex, show.childIndex, "show");

    const hub = data.forms[HUB_FORM_INDEX];
    expect(hub.children.map((child) => (child as RefPrompt).formId)).toEqual([
      "0x2714",
      "0x2725",
      "0x271F",
    ]);
    const restored = hub.children.find(
      (child) => child.type === "Ref" && child.formId === "0x2725",
    ) as RefPrompt | undefined;
    expect(restored?.conditions).toBeUndefined();
    expect(restored?.suppressIf).toBeUndefined();
    expect(restored?.hiddenByTabToggle).toBeUndefined();
    expect(findPage(data, "0x2725").role).toBe("direct-tab");
  });

  it("shows a tab hidden in an earlier session, even though a fresh parse never sets hiddenByTabToggle", () => {
    // Simulates reopening an export (or a data.json) from a session that
    // already hid Advanced: its Ref sits in Chipset sharing the seed's
    // constant-true SuppressIf, exactly what a real parse would produce -
    // hiddenByTabToggle itself is never part of that, see its comment on
    // RefPrompt.
    const data = hubData();
    const hub = data.forms[HUB_FORM_INDEX];
    const chipset = data.forms.find((form) => form.formId === "0x2721");
    if (!chipset) throw new Error("Chipset form missing from fixture");
    const advancedIndex = hub.children.findIndex(
      (child) => child.type === "Ref" && child.formId === "0x2725",
    );
    const [advancedRef] = hub.children.splice(advancedIndex, 1) as [RefPrompt];
    advancedRef.conditions = ["0x170"];
    advancedRef.suppressIf = ["0x170"];
    chipset.children.push(advancedRef);
    refreshSingleFormSetNavigation(data);
    expect(advancedRef.hiddenByTabToggle).toBeUndefined();

    const suppressed = findPage(data, "0x2725");
    expect(suppressed.role).toBe("suppressed-tab");
    const show = analyzeTabVisibilityToggle(
      data,
      buildMenuTree(data),
      suppressed,
      "show",
      HUB_FORM_INDEX,
    );
    expect(show.available).toBe(true);
    if (show.sourceFormIndex === undefined || show.childIndex === undefined) {
      throw new Error("Suppressed tab did not resolve to a location");
    }

    applyTabVisibilityToggle(data, HUB_FORM_INDEX, show.sourceFormIndex, show.childIndex, "show");

    expect(hub.children.map((child) => (child as RefPrompt).formId)).toContain("0x2725");
    expect(findPage(data, "0x2725").role).toBe("direct-tab");
  });
});
