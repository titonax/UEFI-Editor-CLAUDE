import { describe, expect, it } from "vitest";
import {
  applyMoveToDraft,
  canRefBeMoved,
  evaluateMoveDestination,
  listMoveDestinations,
} from "./relocating";
import { buildRefLocation } from "./reparenting";
import type { Data, Form, RefPrompt } from "../scripts/types";

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

describe("canRefBeMoved", () => {
  it("allows a Ref with no condition at all", () => {
    const forms = [
      makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
      makeForm({ formId: "0x2" }),
    ];
    const data = makeData({ forms });
    const location = buildRefLocation(data, 0, 0);

    expect(canRefBeMoved(data, location)).toEqual({ allowed: true });
  });

  it("allows a Ref that's the sole occupant of its own condition", () => {
    const forms = [
      makeForm({
        formId: "0x1",
        children: [makeRef({ formId: "0x2", conditions: ["0x10"] })],
      }),
      makeForm({ formId: "0x2" }),
    ];
    const data = makeData({ forms });
    const location = buildRefLocation(data, 0, 0);

    expect(canRefBeMoved(data, location)).toEqual({ allowed: true });
  });

  it("blocks a Ref that shares its condition with a sibling", () => {
    const forms = [
      makeForm({
        formId: "0x1",
        children: [
          makeRef({ formId: "0x2", conditions: ["0x10"] }),
          makeRef({
            formId: "0x3",
            questionId: "0x0002",
            conditions: ["0x10"],
          }),
        ],
      }),
      makeForm({ formId: "0x2" }),
      makeForm({ formId: "0x3" }),
    ];
    const data = makeData({ forms });
    const location = buildRefLocation(data, 0, 0);

    const result = canRefBeMoved(data, location);
    expect(result.allowed).toBe(false);
  });
});

describe("evaluateMoveDestination", () => {
  const forms = [
    makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
    makeForm({ formId: "0x2" }),
    makeForm({ formId: "0x3" }),
  ];
  const data = makeData({ forms });
  const location = buildRefLocation(data, 0, 0);

  it("allows an unrelated destination", () => {
    expect(evaluateMoveDestination(data, location, 2)).toEqual({
      allowed: true,
    });
  });

  it("blocks moving a Ref back into its current parent", () => {
    expect(evaluateMoveDestination(data, location, 0)).toEqual({
      allowed: false,
      reason: "same-parent",
    });
  });

  it("blocks a destination that would create a cycle", () => {
    // The Ref targets form 0x2 (index 1); moving it into form 0x2 itself
    // would make 0x2 reachable from 0x2.
    expect(evaluateMoveDestination(data, location, 1)).toEqual({
      allowed: false,
      reason: "would-create-cycle",
    });
  });

  it("blocks a destination that already has a Ref to the same target", () => {
    const dupeForms = [
      makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
      makeForm({ formId: "0x2" }),
      makeForm({
        formId: "0x3",
        children: [makeRef({ formId: "0x2", questionId: "0x0002" })],
      }),
    ];
    const dupeData = makeData({ forms: dupeForms });
    const dupeLocation = buildRefLocation(dupeData, 0, 0);

    expect(evaluateMoveDestination(dupeData, dupeLocation, 2)).toEqual({
      allowed: false,
      reason: "duplicate-target",
    });
  });

  it("blocks a destination index that doesn't exist", () => {
    expect(evaluateMoveDestination(data, location, 99)).toEqual({
      allowed: false,
      reason: "target-not-found",
    });
  });
});

describe("listMoveDestinations", () => {
  it("only lists forms in the same FormSet", () => {
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

    const destinations = listMoveDestinations(data, location);

    expect(destinations.map((destination) => destination.formId)).toEqual([
      "0x1",
      "0x2",
      "0x3",
    ]);
  });
});

describe("applyMoveToDraft", () => {
  it("splices the Ref out of its source and appends it to the destination", () => {
    const draft = makeData({
      forms: [
        makeForm({
          formId: "0x1",
          children: [
            makeRef({ formId: "0x2", questionId: "0x0001" }),
            makeRef({ formId: "0x3", questionId: "0x0002" }),
          ],
        }),
        makeForm({
          formId: "0x2",
          children: [makeRef({ formId: "0x4", questionId: "0x0003" })],
        }),
        makeForm({ formId: "0x3" }),
        makeForm({ formId: "0x4" }),
      ],
    });

    applyMoveToDraft(draft, 0, 0, 1);

    expect(draft.forms[0].children).toHaveLength(1);
    expect(draft.forms[0].children[0].questionId).toBe("0x0002");
    expect(draft.forms[1].children).toHaveLength(2);
    expect(draft.forms[1].children[1].questionId).toBe("0x0001");
  });
});
