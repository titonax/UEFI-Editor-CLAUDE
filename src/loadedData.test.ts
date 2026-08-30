import { describe, expect, it } from "vitest";
import { applyLoadedData } from "./loadedData";
import type { Data } from "./components/scripts/types";

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

describe("applyLoadedData", () => {
  it("applies a plain value even when the current draft is null (initial load)", () => {
    const data = makeData({ version: "loaded" });
    expect(applyLoadedData(data, null)).toBe(data);
  });

  it("applies a plain value as a wholesale replacement when data is already loaded", () => {
    const previous = makeData({ version: "old" });
    const next = makeData({ version: "new" });
    expect(applyLoadedData(next, previous)).toBe(next);
  });

  it("runs an in-place edit function against an already-loaded draft", () => {
    const draft = makeData({ version: "before" });
    const result = applyLoadedData((d) => {
      d.version = "after";
    }, draft);
    expect(result).toBeUndefined();
    expect(draft.version).toBe("after");
  });

  it("is a no-op when an edit function is supplied but the draft is still null", () => {
    const result = applyLoadedData(() => {
      throw new Error("should never be called with a null draft");
    }, null);
    expect(result).toBeUndefined();
  });
});
