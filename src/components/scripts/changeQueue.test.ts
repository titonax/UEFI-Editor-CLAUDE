// Ported from titonax/uefi-editor-gpt's own scripts/changeQueue.test.ts,
// unchanged: changeQueue.ts itself was ported verbatim.
import { describe, expect, it } from "vitest";
import {
  analyzeChangeQueue,
  applyAnalyzedChangeQueue,
  setChangeQueueEntryEnabled,
  toggleChangeQueueEntry,
  type ChangeQueueEntry,
} from "./changeQueue";

function entry(
  id: string,
  offset: number,
  expected: number,
  replacement: number,
): ChangeQueueEntry<{ offset: number }> {
  return {
    id,
    family: "test",
    operation: "Edit",
    targetKey: id,
    title: id,
    description: "test change",
    enabled: true,
    patches: [
      {
        bufferId: "source",
        offset,
        expected: new Uint8Array([expected]),
        replacement: new Uint8Array([replacement]),
      },
    ],
    payload: { offset },
  };
}

describe("transactional change queue", () => {
  it("toggles, selects and applies a validated immutable plan", () => {
    const first = entry("first", 1, 2, 9);
    const second = entry("second", 2, 3, 8);
    let queue = toggleChangeQueueEntry([], first);
    queue = toggleChangeQueueEntry(queue, second);
    queue = setChangeQueueEntryEnabled(queue, "second", false);
    const source = new Uint8Array([1, 2, 3]);
    const analysis = analyzeChangeQueue(queue, { source });
    expect(analysis.canApply).toBe(true);
    expect(analysis.stats).toMatchObject({ selectedChanges: 1, changedBytes: 1 });
    expect(applyAnalyzedChangeQueue(analysis, { source }).source).toEqual(
      new Uint8Array([1, 9, 3]),
    );
    expect(source).toEqual(new Uint8Array([1, 2, 3]));
    expect(toggleChangeQueueEntry(queue, first).map((change) => change.id)).toEqual([
      "second",
    ]);
  });

  it("blocks stale and incompatible overlapping patches", () => {
    const queue = [entry("first", 1, 2, 9), entry("second", 1, 7, 8)];
    const analysis = analyzeChangeQueue(queue, {
      source: new Uint8Array([1, 2, 3]),
    });
    expect(analysis.canApply).toBe(false);
    expect(analysis.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["stale-source", "overlapping-patches"]),
    );
  });

  it("deduplicates identical physical work while retaining both semantic changes", () => {
    const queue = [entry("first", 1, 2, 9), entry("second", 1, 2, 9)];
    const analysis = analyzeChangeQueue(queue, {
      source: new Uint8Array([1, 2, 3]),
    });
    expect(analysis.canApply).toBe(true);
    expect(analysis.selectedEntries).toHaveLength(2);
    expect(analysis.patches).toHaveLength(1);
    expect(analysis.stats.deduplicatedSpans).toBe(1);
    expect(analysis.issues).toContainEqual(
      expect.objectContaining({ severity: "warning", code: "deduplicated-patch" }),
    );
  });

  it("enforces dependencies and declared conflicts across the whole selection", () => {
    const dependent = {
      ...entry("dependent", 1, 2, 9),
      dependsOn: ["base"],
      conflictsWith: ["conflict"],
    };
    const conflict = entry("conflict", 2, 3, 8);
    const analysis = analyzeChangeQueue([dependent, conflict], {
      source: new Uint8Array([1, 2, 3]),
    });
    expect(analysis.canApply).toBe(false);
    expect(analysis.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["missing-dependency", "declared-conflict"]),
    );
  });
});
