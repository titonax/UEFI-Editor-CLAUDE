import { describe, expect, it } from "vitest";
import {
  childVisibility,
  combineVisibility,
  conditionsForChild,
  summarizeFormBranch,
  visibilityLabel,
} from "./visibility";
import type {
  CheckBoxPrompt,
  Data,
  Form,
  RefPrompt,
  Suppression,
  VisibilityStatus,
} from "./types";

function makeCheckBox(overrides: Partial<CheckBoxPrompt> = {}): CheckBoxPrompt {
  return {
    name: "A checkbox",
    description: "",
    type: "CheckBox",
    questionId: "0x0001",
    varStoreId: "0x0001",
    varOffset: "0x0000",
    flags: "0x00",
    accessLevel: null,
    failsafe: null,
    optimal: null,
    offsets: null,
    ...overrides,
  };
}

function makeRef(overrides: Partial<RefPrompt> = {}): RefPrompt {
  return {
    name: "Go to page",
    description: "",
    type: "Ref",
    questionId: "0x0002",
    varStoreId: "0x0001",
    formId: "0x2",
    formIdOffset: "0x0",
    pageId: null,
    accessLevel: null,
    failsafe: null,
    optimal: null,
    offsets: null,
    ...overrides,
  };
}

function makeForm(overrides: Partial<Form> = {}): Form {
  return {
    name: "A form",
    type: "Form",
    formId: "0x1",
    referencedIn: [],
    children: [],
    ...overrides,
  };
}

function makeSuppression(overrides: Partial<Suppression> = {}): Suppression {
  return {
    offset: "0x100",
    active: true,
    start: "0x110",
    end: "0x120",
    kind: "SuppressIf",
    constant: null,
    ...overrides,
  };
}

function makeData(overrides: Partial<Data> = {}): Data {
  return {
    firmwareFamily: "aptio-v",
    menu: [],
    forms: [],
    varStores: [],
    suppressions: [],
    version: "test",
    hashes: {
      setupTxt: "",
      setupSct: "",
      amitseSct: "",
      setupdataBin: "",
      offsetChecksum: "",
    },
    ...overrides,
  };
}

describe("visibilityLabel", () => {
  it("returns the human label for each status", () => {
    expect(visibilityLabel("visible")).toBe("No visibility gate");
    expect(visibilityLabel("hidden")).toBe("Hiding gate");
    expect(visibilityLabel("broken")).toBe("Broken reference");
  });
});

describe("conditionsForChild", () => {
  it("resolves offsets to the matching suppressions", () => {
    const suppression = makeSuppression({ offset: "0xAA" });
    const data = makeData({ suppressions: [suppression] });
    const child = makeCheckBox({ conditions: ["0xAA"] });

    expect(conditionsForChild(data, child)).toEqual([suppression]);
  });

  it("falls back to suppressIf when conditions is absent", () => {
    const suppression = makeSuppression({ offset: "0xBB" });
    const data = makeData({ suppressions: [suppression] });
    const child = makeCheckBox({ suppressIf: ["0xBB"] });

    expect(conditionsForChild(data, child)).toEqual([suppression]);
  });

  it("drops offsets that don't resolve to a known suppression", () => {
    const data = makeData({ suppressions: [] });
    const child = makeCheckBox({ conditions: ["0xMissing"] });

    expect(conditionsForChild(data, child)).toEqual([]);
  });
});

describe("childVisibility", () => {
  it("is visible with no conditions", () => {
    const data = makeData();
    const info = childVisibility(data, makeCheckBox());
    expect(info.status).toBe("visible");
    expect(info.gate).toBe("none");
  });

  it("mentions the AMI access level when there is no active condition", () => {
    const data = makeData();
    const info = childVisibility(data, makeCheckBox({ accessLevel: "05" }));
    expect(info.status).toBe("visible");
    expect(info.explanation).toContain("0x05");
  });

  it("is hidden by an active, non-constant SuppressIf", () => {
    const suppression = makeSuppression({ offset: "0x1", constant: null });
    const data = makeData({ suppressions: [suppression] });
    const info = childVisibility(
      data,
      makeCheckBox({ conditions: ["0x1"], suppressIf: ["0x1"] }),
    );
    expect(info.status).toBe("hidden");
    expect(info.label).toBe("Hidden when true");
  });

  it("is always hidden when the SuppressIf is a constant true", () => {
    const suppression = makeSuppression({ offset: "0x1", constant: true });
    const data = makeData({ suppressions: [suppression] });
    const info = childVisibility(
      data,
      makeCheckBox({ conditions: ["0x1"], suppressIf: ["0x1"] }),
    );
    expect(info.status).toBe("hidden");
    expect(info.label).toBe("Always hidden");
  });

  it("ignores a SuppressIf that is a constant false", () => {
    const suppression = makeSuppression({ offset: "0x1", constant: false });
    const data = makeData({ suppressions: [suppression] });
    const info = childVisibility(
      data,
      makeCheckBox({ conditions: ["0x1"], suppressIf: ["0x1"] }),
    );
    expect(info.status).toBe("visible");
  });

  it("ignores an inactive SuppressIf", () => {
    const suppression = makeSuppression({
      offset: "0x1",
      active: false,
      constant: true,
    });
    const data = makeData({ suppressions: [suppression] });
    const info = childVisibility(
      data,
      makeCheckBox({ conditions: ["0x1"], suppressIf: ["0x1"] }),
    );
    expect(info.status).toBe("visible");
  });

  it("is conditional (not hidden) for GrayOutIf/DisableIf", () => {
    const suppression = makeSuppression({
      offset: "0x1",
      kind: "GrayOutIf",
      constant: null,
    });
    const data = makeData({ suppressions: [suppression] });
    // GrayOutIf/DisableIf are not SuppressIf, so they only ever reach the
    // child through `conditions`, never `suppressIf`.
    const info = childVisibility(data, makeCheckBox({ conditions: ["0x1"] }));
    expect(info.status).toBe("conditional");
    expect(info.gate).toBe("availability");
  });

  it("flags hardware/access/ui dependence from the condition source", () => {
    const suppression = makeSuppression({
      offset: "0x1",
      kind: "GrayOutIf",
      constant: null,
      source: "hardware",
    });
    const data = makeData({ suppressions: [suppression] });
    const info = childVisibility(data, makeCheckBox({ conditions: ["0x1"] }));
    expect(info.hardwareDependent).toBe(true);
    expect(info.accessDependent).toBe(false);
    expect(info.uiStateDependent).toBe(false);
  });
});

describe("combineVisibility", () => {
  const cases: [VisibilityStatus, VisibilityStatus, VisibilityStatus][] = [
    ["visible", "visible", "visible"],
    ["hidden", "visible", "hidden"],
    ["visible", "hidden", "hidden"],
    ["conditional", "visible", "conditional"],
    ["visible", "conditional", "conditional"],
    ["hidden", "conditional", "hidden"],
    // Any status other than hidden/conditional (including broken/orphaned/
    // unknown) is treated as an open gate for combination purposes.
    ["broken", "visible", "visible"],
    ["visible", "broken", "visible"],
  ];

  it.each(cases)("combine(%s, %s) => %s", (parent, child, expected) => {
    expect(combineVisibility(parent, child)).toBe(expected);
  });
});

describe("summarizeFormBranch", () => {
  it("counts direct children separately from the whole branch", () => {
    const target = makeForm({
      formId: "0x2",
      children: [makeCheckBox({ questionId: "0x10" })],
    });
    const root = makeForm({
      formId: "0x1",
      children: [
        makeCheckBox({ questionId: "0x11" }),
        makeRef({ formId: "0x2" }),
      ],
    });
    const data = makeData({ forms: [root, target] });

    const summary = summarizeFormBranch(data, 0);

    // Direct: the checkbox + the Ref itself (2 items on the root form).
    expect(summary.direct.visible).toBe(2);
    // Branch: same 2, plus the target form's own checkbox.
    expect(summary.branch.visible).toBe(3);
    expect(summary.descendantForms).toBe(1);
  });

  it("marks a Ref to a nonexistent form as broken", () => {
    const root = makeForm({
      formId: "0x1",
      children: [makeRef({ formId: "0xDEAD" })],
    });
    const data = makeData({ forms: [root] });

    const summary = summarizeFormBranch(data, 0);

    expect(summary.direct.broken).toBe(1);
    expect(summary.descendantForms).toBe(0);
  });

  it("does not infinite-loop on a Ref cycle", () => {
    const formA = makeForm({
      formId: "0x1",
      children: [makeRef({ formId: "0x2" })],
    });
    const formB = makeForm({
      formId: "0x2",
      children: [makeRef({ formId: "0x1" })],
    });
    const data = makeData({ forms: [formA, formB] });

    const summary = summarizeFormBranch(data, 0);

    // Both Refs are counted once each (root's own Ref, and formB's Ref back
    // to formA), but the cycle back to an ancestor is not re-visited.
    expect(summary.branch.visible).toBe(2);
    expect(summary.descendantForms).toBe(1);
  });

  it("propagates a hidden ancestor status down the branch", () => {
    const target = makeForm({
      formId: "0x2",
      children: [makeCheckBox({ questionId: "0x10" })],
    });
    const suppression = makeSuppression({ offset: "0x1", constant: true });
    const root = makeForm({
      formId: "0x1",
      children: [makeRef({ formId: "0x2", conditions: ["0x1"] })],
    });
    const data = makeData({
      forms: [root, target],
      suppressions: [suppression],
    });

    const summary = summarizeFormBranch(data, 0);

    // The Ref itself is hidden, and so is everything reached through it.
    expect(summary.direct.hidden).toBe(1);
    expect(summary.branch.hidden).toBe(2);
  });

  it("counts condition sources for direct and branch separately", () => {
    const hwSuppression = makeSuppression({
      offset: "0x1",
      kind: "GrayOutIf",
      source: "hardware",
    });
    const target = makeForm({
      formId: "0x2",
      children: [
        makeCheckBox({ questionId: "0x10", conditions: ["0x1"] }),
      ],
    });
    const root = makeForm({
      formId: "0x1",
      children: [makeRef({ formId: "0x2" })],
    });
    const data = makeData({
      forms: [root, target],
      suppressions: [hwSuppression],
    });

    const summary = summarizeFormBranch(data, 0);

    expect(summary.directSources.hardware).toBe(0);
    expect(summary.branchSources.hardware).toBe(1);
  });
});
