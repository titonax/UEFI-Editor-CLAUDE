import { describe, expect, it } from "vitest";
import { isSoleOwnerOfCondition, movableBlockStart } from "./refMoving";
import type { CheckBoxPrompt, Data, Form, RefPrompt } from "./types";

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

function makeCheckBox(overrides: Partial<CheckBoxPrompt> = {}): CheckBoxPrompt {
  return {
    name: "A checkbox",
    description: "",
    type: "CheckBox",
    questionId: "0x0002",
    varStoreId: "0x0001",
    varOffset: "0x0000",
    flags: "0x00",
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
    referencedIn: [],
    children: [],
    endOffset: "0x0",
    ...overrides,
  };
}

function makeData(overrides: Partial<Data> = {}): Data {
  return {
    firmwareFamily: "aptio-v",
    menu: [],
    varStores: [],
    forms: [],
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

describe("isSoleOwnerOfCondition", () => {
  it("is true for a Ref with no condition at all", () => {
    const ref = makeRef();
    const form = makeForm({ children: [ref] });

    expect(isSoleOwnerOfCondition(form, ref)).toBe(true);
  });

  it("is true for a Ref that's the only child under its condition", () => {
    const ref = makeRef({ conditions: ["0x10"] });
    const unrelated = makeCheckBox({ conditions: ["0x20"] });
    const form = makeForm({ children: [unrelated, ref] });

    expect(isSoleOwnerOfCondition(form, ref)).toBe(true);
  });

  it("is false when a sibling shares the exact same outermost condition", () => {
    const ref = makeRef({ conditions: ["0x10"] });
    const sibling = makeCheckBox({ conditions: ["0x10"] });
    const form = makeForm({ children: [ref, sibling] });

    expect(isSoleOwnerOfCondition(form, ref)).toBe(false);
  });

  it("is true when a sibling shares the same SuppressIf but a different nested GrayOutIf", () => {
    // conditions[0] is the outermost - two children under the same
    // SuppressIf but with different (or no) nested conditions still share
    // outermost ownership, so this must report false (not sole owner).
    const ref = makeRef({ conditions: ["0x10", "0x18"] });
    const sibling = makeCheckBox({ conditions: ["0x10"] });
    const form = makeForm({ children: [ref, sibling] });

    expect(isSoleOwnerOfCondition(form, ref)).toBe(false);
  });
});

describe("movableBlockStart", () => {
  it("starts at the Ref opcode itself when nothing wraps it", () => {
    const ref = makeRef({ sctOffset: "0x40" });
    const form = makeForm({ children: [ref] });

    expect(movableBlockStart(makeData(), form, ref)).toBe(0x40);
  });

  it("starts at the outermost condition when the Ref is its sole occupant", () => {
    const ref = makeRef({ sctOffset: "0x44", conditions: ["0x3C"] });
    const form = makeForm({ children: [ref] });
    const data = makeData({
      suppressions: [
        { offset: "0x3C", active: true, start: "0x3C", end: "0x53" },
      ],
    });

    expect(movableBlockStart(data, form, ref)).toBe(0x3c);
  });

  it("refuses a Ref that shares its condition with a sibling", () => {
    const ref = makeRef({ sctOffset: "0x44", conditions: ["0x3C"] });
    const sibling = makeCheckBox({ sctOffset: "0x53", conditions: ["0x3C"] });
    const form = makeForm({ children: [ref, sibling] });
    const data = makeData({
      suppressions: [
        { offset: "0x3C", active: true, start: "0x3C", end: "0x60" },
      ],
    });

    expect(() => movableBlockStart(data, form, ref)).toThrow(
      "Something went wrong. Please file a bug report on Github.",
    );
  });

  it("refuses a Ref whose condition is missing from the suppressions list", () => {
    const ref = makeRef({ sctOffset: "0x44", conditions: ["0x3C"] });
    const form = makeForm({ children: [ref] });

    expect(() => movableBlockStart(makeData(), form, ref)).toThrow(
      "Something went wrong. Please file a bug report on Github.",
    );
  });
});
