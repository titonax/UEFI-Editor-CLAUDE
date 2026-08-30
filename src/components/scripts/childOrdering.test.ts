import { describe, expect, it } from "vitest";
import {
  computeChildBlocks,
  computeReorderPieces,
  remapOffsetIfMoved,
  swapAdjacentBlocks,
} from "./childOrdering";
import type { CheckBoxPrompt, Form } from "./types";

function makeChild(overrides: Partial<CheckBoxPrompt> = {}): CheckBoxPrompt {
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

describe("computeChildBlocks", () => {
  it("treats every unconditioned child as its own block", () => {
    const children = [makeChild({ name: "A" }), makeChild({ name: "B" })];

    const blocks = computeChildBlocks(children);

    expect(blocks).toEqual([
      { startIndex: 0, endIndex: 1, conditionOffset: undefined },
      { startIndex: 1, endIndex: 2, conditionOffset: undefined },
    ]);
  });

  it("groups consecutive children sharing the same outermost condition", () => {
    const children = [
      makeChild({ name: "A" }),
      makeChild({ name: "B", conditions: ["0x10"] }),
      makeChild({ name: "C", conditions: ["0x10"] }),
      makeChild({ name: "D" }),
    ];

    const blocks = computeChildBlocks(children);

    expect(blocks).toEqual([
      { startIndex: 0, endIndex: 1, conditionOffset: undefined },
      { startIndex: 1, endIndex: 3, conditionOffset: "0x10" },
      { startIndex: 3, endIndex: 4, conditionOffset: undefined },
    ]);
  });

  it("groups by the outermost condition only, ignoring nested ones", () => {
    // A GrayOutIf (offset 0x20) nested inside a SuppressIf (offset 0x10):
    // conditions is [outermost, ..., innermost], so grouping must key off
    // conditions[0] - two children sharing the SuppressIf but with
    // different (or no) nested GrayOutIf still belong to the same block.
    const children = [
      makeChild({ name: "A", conditions: ["0x10"] }),
      makeChild({ name: "B", conditions: ["0x10", "0x20"] }),
    ];

    const blocks = computeChildBlocks(children);

    expect(blocks).toEqual([
      { startIndex: 0, endIndex: 2, conditionOffset: "0x10" },
    ]);
  });

  it("keeps two different conditions as separate blocks even when adjacent", () => {
    const children = [
      makeChild({ name: "A", conditions: ["0x10"] }),
      makeChild({ name: "B", conditions: ["0x20"] }),
    ];

    const blocks = computeChildBlocks(children);

    expect(blocks).toEqual([
      { startIndex: 0, endIndex: 1, conditionOffset: "0x10" },
      { startIndex: 1, endIndex: 2, conditionOffset: "0x20" },
    ]);
  });

  it("returns an empty list for an empty children array", () => {
    expect(computeChildBlocks([])).toEqual([]);
  });
});

describe("swapAdjacentBlocks", () => {
  it("swaps two singleton blocks", () => {
    const children = [makeChild({ name: "A" }), makeChild({ name: "B" })];
    const blocks = computeChildBlocks(children);

    const result = swapAdjacentBlocks(children, blocks, 0, "down");

    expect(result.map((child) => child.name)).toEqual(["B", "A"]);
  });

  it("moves a whole conditioned block atomically, preserving its internal order", () => {
    const children = [
      makeChild({ name: "A" }),
      makeChild({ name: "B", conditions: ["0x10"] }),
      makeChild({ name: "C", conditions: ["0x10"] }),
    ];
    const blocks = computeChildBlocks(children);

    // Move the {B, C} block up, past A.
    const result = swapAdjacentBlocks(children, blocks, 1, "up");

    expect(result.map((child) => child.name)).toEqual(["B", "C", "A"]);
    // The moved children still carry their own condition metadata - moving
    // them doesn't unhide them.
    expect(result[0].conditions).toEqual(["0x10"]);
    expect(result[1].conditions).toEqual(["0x10"]);
  });

  it("is a no-op moving the first block up", () => {
    const children = [makeChild({ name: "A" }), makeChild({ name: "B" })];
    const blocks = computeChildBlocks(children);

    const result = swapAdjacentBlocks(children, blocks, 0, "up");

    expect(result).toBe(children);
  });

  it("is a no-op moving the last block down", () => {
    const children = [makeChild({ name: "A" }), makeChild({ name: "B" })];
    const blocks = computeChildBlocks(children);

    const result = swapAdjacentBlocks(children, blocks, 1, "down");

    expect(result).toBe(children);
  });

  it("leaves an untouched third block exactly where it was", () => {
    const children = [
      makeChild({ name: "A" }),
      makeChild({ name: "B" }),
      makeChild({ name: "C" }),
    ];
    const blocks = computeChildBlocks(children);

    const result = swapAdjacentBlocks(children, blocks, 0, "down");

    expect(result.map((child) => child.name)).toEqual(["B", "A", "C"]);
  });
});

describe("computeReorderPieces", () => {
  it("returns null when the current order already matches the pristine layout", () => {
    const form = makeForm({
      endOffset: "0x24",
      children: [
        makeChild({ name: "A", sctOffset: "0x10" }),
        makeChild({ name: "B", sctOffset: "0x14", conditions: ["0x14"] }),
        makeChild({ name: "C", sctOffset: "0x20" }),
      ],
    });

    expect(computeReorderPieces(form)).toBeNull();
  });

  it("computes pristine-byte pieces for a 3-block rotation, including a conditioned block", () => {
    // Pristine layout: A at 0x10 (len 4), a SuppressIf-wrapped B whose
    // condition opens at 0x14 (len 12, i.e. up to 0x20), C at 0x20 (len 4,
    // up to the Form's own End at 0x24). Current (already-edited) order is
    // [C, B, A] - C and A swapped past the conditioned B block.
    const form = makeForm({
      endOffset: "0x24",
      children: [
        makeChild({ name: "C", sctOffset: "0x20" }),
        makeChild({ name: "B", sctOffset: "0x18", conditions: ["0x14"] }),
        makeChild({ name: "A", sctOffset: "0x10" }),
      ],
    });

    const pieces = computeReorderPieces(form);

    expect(pieces).toEqual([
      { oldStart: 0x20, length: 4, newStart: 0x10 },
      { oldStart: 0x14, length: 12, newStart: 0x14 },
      { oldStart: 0x10, length: 4, newStart: 0x20 },
    ]);
  });

  it("returns null for a Form with no children", () => {
    expect(computeReorderPieces(makeForm({ children: [] }))).toBeNull();
  });
});

describe("remapOffsetIfMoved", () => {
  const pieces = [
    { oldStart: 0x20, length: 4, newStart: 0x10 },
    { oldStart: 0x14, length: 12, newStart: 0x14 },
    { oldStart: 0x10, length: 4, newStart: 0x20 },
  ];

  it("shifts an offset that falls inside a moved piece", () => {
    // 0x12 sits inside the third piece's pristine range [0x10, 0x14) -
    // that piece moved from 0x10 to 0x20, a +0x10 delta.
    expect(remapOffsetIfMoved(0x12, pieces)).toBe(0x22);
  });

  it("leaves an offset inside a zero-delta piece unchanged", () => {
    expect(remapOffsetIfMoved(0x14, pieces)).toBe(0x14);
  });

  it("leaves an offset outside every piece unchanged", () => {
    expect(remapOffsetIfMoved(0x100, pieces)).toBe(0x100);
  });
});
