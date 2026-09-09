import { describe, expect, it } from "vitest";
import { isSoleOwnerOfCondition } from "./refMoving";
import type { CheckBoxPrompt, Form, RefPrompt } from "./types";

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
