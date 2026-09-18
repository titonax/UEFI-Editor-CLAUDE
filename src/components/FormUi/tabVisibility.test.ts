import { describe, expect, it } from "vitest";
import { buildMenuTree } from "../Navigation/menuTree";
import {
  inspectSingleFormSetNavigation,
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
  });
  const main = makeForm({ name: "Main", formId: "0x2714", referencedIn: ["0x2711"] });
  const advanced = makeForm({ name: "Advanced", formId: "0x2725", referencedIn: ["0x2711"] });
  const boot = makeForm({ name: "Boot", formId: "0x271F", referencedIn: ["0x2711"] });
  const legacyTarget = makeForm({ name: "Legacy", formId: "0x2730" });
  const chipset = makeForm({
    name: "Chipset",
    formId: "0x2721",
    children: [
      makeRef({
        name: "Legacy",
        formId: "0x2730",
        sctOffset: "0x200",
        questionId: "0x4",
        conditions: ["0x9000"],
        suppressIf: ["0x9000"],
      }),
    ],
  });
  const forms = [hub, main, advanced, boot, chipset, legacyTarget];
  const suppressions: Suppression[] = [
    {
      offset: "0x9000",
      active: true,
      start: "0x9000",
      end: "0x9010",
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
      conditions: ["0x9000"],
      suppressIf: ["0x9000"],
      hiddenByTabToggle: "0x9000",
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
      suppressionOffset: "0x9000",
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
      conditions: ["0x9000"],
      suppressIf: ["0x9000"],
      hiddenByTabToggle: "0x9000",
    });
    expect(findPage(data, "0x2725")).toMatchObject({
      role: "suppressed-tab",
      suppressionOffset: "0x9000",
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
});
