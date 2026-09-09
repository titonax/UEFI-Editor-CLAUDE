import { describe, expect, it } from "vitest";
import {
  buildRefLocation,
  evaluateMoveCandidate,
  findIncomingRefs,
  listMoveCandidates,
  wouldCreateCycle,
} from "./reparenting";
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

describe("findIncomingRefs", () => {
  it("finds a single Ref pointing at the target form", () => {
    const forms = [
      makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
      makeForm({ formId: "0x2" }),
    ];
    const data = makeData({ forms });

    const refs = findIncomingRefs(data, 1);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      sourceFormIndex: 0,
      childIndex: 0,
      targetFormIndex: 1,
      isSelfReference: false,
    });
  });

  it("finds every Ref when a form is reached from multiple distinct parents", () => {
    const forms = [
      makeForm({ formId: "0x1", children: [makeRef({ formId: "0x3" })] }),
      makeForm({ formId: "0x2", children: [makeRef({ formId: "0x3" })] }),
      makeForm({ formId: "0x3" }),
    ];
    const data = makeData({ forms });

    const refs = findIncomingRefs(data, 2);

    expect(refs).toHaveLength(2);
    expect(refs.map((location) => location.sourceFormIndex).sort()).toEqual([0, 1]);
    expect(refs.every((location) => !location.isSelfReference)).toBe(true);
  });

  it("flags a Ref that points back at its own containing form", () => {
    // Checked against a real firmware image: every Form there with more
    // than one incoming Ref turned out to be exactly this pattern - action
    // buttons ("Save Changes and Exit", "Discard Changes", "Restore
    // Defaults", ...) implemented as Refs pointing back at their own Form,
    // not genuine navigation from other pages.
    const forms = [
      makeForm({
        formId: "0x1",
        children: [
          makeRef({ name: "Save Changes and Exit", formId: "0x1" }),
          makeRef({ name: "Discard Changes", formId: "0x1" }),
        ],
      }),
    ];
    const data = makeData({ forms });

    const refs = findIncomingRefs(data, 0);

    expect(refs).toHaveLength(2);
    expect(refs.every((location) => location.isSelfReference)).toBe(true);
  });

  it("returns an empty list for a form nothing points at", () => {
    const forms = [makeForm({ formId: "0x1" })];
    const data = makeData({ forms });

    expect(findIncomingRefs(data, 0)).toEqual([]);
  });
});

describe("wouldCreateCycle", () => {
  it("is true when retargeting a Ref to point back at its own containing form", () => {
    const data = makeData({
      forms: [makeForm({ formId: "0x1" }), makeForm({ formId: "0x2" })],
    });

    expect(wouldCreateCycle(data, { sourceFormIndex: 0 }, 0)).toBe(true);
  });

  it("is true when the new target can already reach back to the source through existing Refs", () => {
    // 0 -> 1 -> 2. Retargeting some other Ref in form 0 to point at form 2
    // would make form 0 reachable again once you follow 2's own path back
    // through 1 to 0 - a cycle, even though 2 doesn't Ref 0 directly.
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

describe("evaluateMoveCandidate", () => {
  const forms = [
    makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
    makeForm({ formId: "0x2" }),
    makeForm({ formId: "0x3" }),
  ];
  const data = makeData({ forms });
  const location = findIncomingRefs(data, 1)[0];

  it("allows a move to an unrelated form", () => {
    expect(evaluateMoveCandidate(data, location, 2)).toEqual({ allowed: true });
  });

  it("blocks a no-op move to the current target", () => {
    expect(evaluateMoveCandidate(data, location, 1)).toEqual({
      allowed: false,
      reason: "same-target",
    });
  });

  it("blocks a move that would create a cycle", () => {
    expect(evaluateMoveCandidate(data, location, 0)).toEqual({
      allowed: false,
      reason: "would-create-cycle",
    });
  });

  it("blocks a move to a form index that doesn't exist", () => {
    expect(evaluateMoveCandidate(data, location, 99)).toEqual({
      allowed: false,
      reason: "target-not-found",
    });
  });
});

describe("buildRefLocation", () => {
  it("builds the same location findIncomingRefs would have found", () => {
    const forms = [
      makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
      makeForm({ formId: "0x2" }),
    ];
    const data = makeData({ forms });

    expect(buildRefLocation(data, 0, 0)).toEqual(findIncomingRefs(data, 1)[0]);
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
    };
    const forms = [makeForm({ formId: "0x1", children: [notARef] })];
    const data = makeData({ forms });

    expect(() => buildRefLocation(data, 0, 0)).toThrow(/Something went wrong/);
  });
});

describe("listMoveCandidates", () => {
  it("only lists forms in the same FormSet as the Ref's target", () => {
    const forms = [
      makeForm({
        formId: "0x1",
        formSetGuid: "AAAA",
        children: [makeRef({ formId: "0x2" })],
      }),
      makeForm({ formId: "0x2", formSetGuid: "AAAA" }),
      makeForm({ formId: "0x3", formSetGuid: "AAAA" }),
      makeForm({ formId: "0x4", formSetGuid: "BBBB" }),
    ];
    const data = makeData({ forms });
    const location = buildRefLocation(data, 0, 0);

    const candidates = listMoveCandidates(data, location);

    expect(candidates.map((candidate) => candidate.formId)).toEqual([
      "0x1",
      "0x2",
      "0x3",
    ]);
  });

  it("carries evaluateMoveCandidate's verdict for each candidate", () => {
    const forms = [
      makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
      makeForm({ formId: "0x2" }),
      makeForm({ formId: "0x3" }),
    ];
    const data = makeData({ forms });
    const location = buildRefLocation(data, 0, 0);

    const candidates = listMoveCandidates(data, location);

    expect(candidates).toEqual([
      { formIndex: 0, formId: "0x1", name: "A form", result: { allowed: false, reason: "would-create-cycle" } },
      { formIndex: 1, formId: "0x2", name: "A form", result: { allowed: false, reason: "same-target" } },
      { formIndex: 2, formId: "0x3", name: "A form", result: { allowed: true } },
    ]);
  });
});
