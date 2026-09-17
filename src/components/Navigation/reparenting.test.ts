import { describe, expect, it } from "vitest";
import { buildRefLocation, resolveRefTarget, wouldCreateCycle } from "./reparenting";
import type { Data, Form, RefPrompt, StringPrompt } from "../scripts/types";

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

describe("resolveRefTarget", () => {
  it("prefers a Form in the Ref's own FormSet over a same-id Form elsewhere", () => {
    const forms = [
      makeForm({ formId: "0x1", formSetGuid: "AAAA", children: [makeRef({ formId: "0x2" })] }),
      makeForm({ formId: "0x2", formSetGuid: "BBBB" }),
      makeForm({ formId: "0x2", formSetGuid: "AAAA" }),
    ];
    const data = makeData({ forms });

    expect(resolveRefTarget(data, 0, forms[0].children[0] as RefPrompt)).toBe(2);
  });

  it("follows an explicit target FormSet", () => {
    const forms = [
      makeForm({
        formId: "0x1",
        formSetGuid: "AAAA",
        children: [makeRef({ formId: "0x2", targetFormSetGuid: "BBBB" })],
      }),
      makeForm({ formId: "0x2", formSetGuid: "AAAA" }),
      makeForm({ formId: "0x2", formSetGuid: "BBBB" }),
    ];
    const data = makeData({ forms });

    expect(resolveRefTarget(data, 0, forms[0].children[0] as RefPrompt)).toBe(2);
  });
});

describe("wouldCreateCycle", () => {
  it("is true when the new target is the Ref's own containing form", () => {
    const data = makeData({
      forms: [makeForm({ formId: "0x1" }), makeForm({ formId: "0x2" })],
    });

    expect(wouldCreateCycle(data, { sourceFormIndex: 0 }, 0)).toBe(true);
  });

  it("is true when the new target can already reach back to the source through existing Refs", () => {
    // 0 -> 1 -> 2 -> 0. A Ref in form 0 pointing at form 2 closes the loop
    // even though 2 doesn't Ref 0 directly.
    const forms = [
      makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
      makeForm({ formId: "0x2", children: [makeRef({ formId: "0x3" })] }),
      makeForm({ formId: "0x3", children: [makeRef({ formId: "0x1" })] }),
    ];
    const data = makeData({ forms });

    expect(wouldCreateCycle(data, { sourceFormIndex: 0 }, 2)).toBe(true);
  });

  it("is false for a target that can't reach back to the source", () => {
    const forms = [
      makeForm({ formId: "0x1" }),
      makeForm({ formId: "0x2" }),
      makeForm({ formId: "0x3" }),
    ];
    const data = makeData({ forms });

    expect(wouldCreateCycle(data, { sourceFormIndex: 0 }, 2)).toBe(false);
  });

  it("does not loop forever when the existing graph already has a cycle", () => {
    const forms = [
      makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
      makeForm({ formId: "0x2", children: [makeRef({ formId: "0x1" })] }),
      makeForm({ formId: "0x3" }),
    ];
    const data = makeData({ forms });

    expect(wouldCreateCycle(data, { sourceFormIndex: 2 }, 0)).toBe(false);
  });
});

describe("buildRefLocation", () => {
  it("describes the Ref at the given position", () => {
    const forms = [
      makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
      makeForm({ formId: "0x2" }),
    ];
    const data = makeData({ forms });

    expect(buildRefLocation(data, 0, 0)).toEqual({
      sourceFormIndex: 0,
      childIndex: 0,
      ref: forms[0].children[0],
      targetFormIndex: 1,
      isSelfReference: false,
    });
  });

  it("reports a dangling target as -1", () => {
    const forms = [makeForm({ formId: "0x1", children: [makeRef({ formId: "0xDEAD" })] })];
    const data = makeData({ forms });

    expect(buildRefLocation(data, 0, 0).targetFormIndex).toBe(-1);
  });

  it("flags a self-referencing Ref", () => {
    const forms = [
      makeForm({
        formId: "0x1",
        children: [makeRef({ name: "Save Changes and Exit", formId: "0x1" })],
      }),
    ];
    const data = makeData({ forms });

    expect(buildRefLocation(data, 0, 0)).toMatchObject({
      targetFormIndex: 0,
      isSelfReference: true,
    });
  });

  it("throws when the given child isn't a Ref", () => {
    const notARef: StringPrompt = {
      name: "A text field",
      description: "",
      type: "String",
      questionId: "0x0001",
      varStoreId: "0x0001",
      accessLevel: null,
      failsafe: null,
      optimal: null,
      offsets: null,
      sctOffset: "0x0",
    };
    const forms = [makeForm({ formId: "0x1", children: [notARef] })];
    const data = makeData({ forms });

    expect(() => buildRefLocation(data, 0, 0)).toThrow(/Something went wrong/);
  });
});
