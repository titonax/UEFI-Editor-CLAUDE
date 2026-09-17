import { describe, expect, it } from "vitest";
import {
  assertAmiRootVisibilityEditsMatch,
  desiredAmiRootVisibility,
  toggleAmiRootVisibility,
} from "./amiRootVisibilityEditing";
import type { AmiRootVisibilityEdit, AmiRootVisibilityReport } from "./types";

const guid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

function report(): AmiRootVisibilityReport {
  return {
    status: "detected",
    mechanism: "setup-pe32-root-byte-vector",
    confidence: "corroborated",
    reason: "test vector",
    vector: {
      bufferId: 7,
      offset: 0x100,
      length: 2,
      codeReferenceOffset: 0x20,
      pageTableOffset: 0x200,
      countEvidence: "immediate",
    },
    entries: [
      {
        rootIndex: 0,
        name: "Hidden Advanced",
        formId: "0x402",
        formSetGuid: guid,
        value: 0,
        visible: false,
        bufferOffset: 0x100,
      },
      {
        rootIndex: 1,
        name: "Visible Main",
        formId: "0x400",
        formSetGuid: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
        value: 1,
        visible: true,
        bufferOffset: 0x101,
      },
    ],
  };
}

function state(rootVisibilityEdits?: AmiRootVisibilityEdit[]) {
  return { rootVisibility: report(), rootVisibilityEdits };
}

describe("toggleAmiRootVisibility", () => {
  it("records a desired state without touching the original evidence", () => {
    const data = state();
    const edits = toggleAmiRootVisibility(data, 0);

    expect(edits).toEqual([
      {
        kind: "set-root-visibility",
        rootIndex: 0,
        formId: "0x402",
        formSetGuid: guid,
        bufferId: 7,
        bufferOffset: 0x100,
        expected: 0,
        replacement: 1,
        description: "Show root FormSet Hidden Advanced",
      },
    ]);
    expect(data.rootVisibility.entries[0]).toMatchObject({ value: 0, visible: false });
    expect(desiredAmiRootVisibility({ ...data, rootVisibilityEdits: edits }, report().entries[0])).toBe(1);
  });

  it("removes the pending edit when a root is toggled back to its original state", () => {
    const first = toggleAmiRootVisibility(state(), 1);
    const second = toggleAmiRootVisibility(state(first), 1);

    expect(first?.[0]).toMatchObject({ expected: 1, replacement: 0, description: "Hide root FormSet Visible Main" });
    expect(second).toBeUndefined();
  });

  it("keeps other roots' pending edits when one is reverted", () => {
    const both = toggleAmiRootVisibility(state(toggleAmiRootVisibility(state(), 0)), 1);
    const reverted = toggleAmiRootVisibility(state(both), 1);

    expect(both?.map((edit) => edit.rootIndex)).toEqual([0, 1]);
    expect(reverted?.map((edit) => edit.rootIndex)).toEqual([0]);
  });

  it("refuses to plan without a detected vector", () => {
    expect(() => toggleAmiRootVisibility({ rootVisibility: undefined }, 0)).toThrow(
      /without a unique code-corroborated vector/,
    );
  });

  it("refuses an unknown root", () => {
    expect(() => toggleAmiRootVisibility(state(), 5)).toThrow(/entry 5 was not found/);
  });
});

describe("assertAmiRootVisibilityEditsMatch", () => {
  it("accepts an empty plan against anything", () => {
    expect(() => {
      assertAmiRootVisibilityEditsMatch(undefined, undefined);
      assertAmiRootVisibilityEditsMatch([], undefined);
    }).not.toThrow();
  });

  it("rejects a saved plan whose byte provenance does not match", () => {
    const edits = toggleAmiRootVisibility(state(), 0);
    if (!edits) throw new Error("expected a root visibility edit");
    edits[0].bufferOffset = 0x999;

    expect(() => {
      assertAmiRootVisibilityEditsMatch(edits, report());
    }).toThrow(/does not match the opened firmware/);
  });

  it("rejects a saved plan when the opened firmware has no detected vector", () => {
    const edits = toggleAmiRootVisibility(state(), 0);

    expect(() => {
      assertAmiRootVisibilityEditsMatch(edits, { ...report(), status: "unresolved", vector: undefined });
    }).toThrow(/do not have a detected vector/);
  });

  it("rejects duplicate roots in a saved plan", () => {
    const edits = toggleAmiRootVisibility(state(), 0);
    if (!edits) throw new Error("expected a root visibility edit");

    expect(() => {
      assertAmiRootVisibilityEditsMatch([...edits, ...edits], report());
    }).toThrow(/duplicate root 0/);
  });
});
