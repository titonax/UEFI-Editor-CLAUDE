import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_NAVIGATION_WIDTH,
  MIN_NAVIGATION_WIDTH,
  NAVIGATION_WIDTH_STORAGE_KEY,
  clampNavigationWidth,
  defaultNavigationWidth,
  maxNavigationWidth,
  persistNavigationWidth,
  readStoredNavigationWidth,
  storedNavigationWidth,
} from "./navigationWidth";

describe("defaultNavigationWidth", () => {
  it("keeps the responsive defaults of the fixed navbar", () => {
    expect(defaultNavigationWidth(500)).toBe(220);
    expect(defaultNavigationWidth(576)).toBe(240);
    expect(defaultNavigationWidth(800)).toBe(280);
    expect(defaultNavigationWidth(992)).toBe(320);
    expect(defaultNavigationWidth(1400)).toBe(360);
  });
});

describe("maxNavigationWidth", () => {
  it("reserves room for the content pane and caps very wide trees", () => {
    expect(maxNavigationWidth(1000)).toBe(640);
    expect(maxNavigationWidth(4000)).toBe(MAX_NAVIGATION_WIDTH);
  });

  it("never drops below the tree's own minimum on a tiny viewport", () => {
    expect(maxNavigationWidth(300)).toBe(MIN_NAVIGATION_WIDTH);
  });
});

describe("clampNavigationWidth", () => {
  it("clamps into the viewport's range and rounds to whole pixels", () => {
    expect(clampNavigationWidth(900, 1000)).toBe(640);
    expect(clampNavigationWidth(100, 1000)).toBe(200);
    expect(clampNavigationWidth(333.6, 1000)).toBe(334);
  });

  it("falls back to the responsive default for a non-finite width", () => {
    expect(clampNavigationWidth(Number.NaN, 1400)).toBe(360);
    expect(clampNavigationWidth(Number.POSITIVE_INFINITY, 800)).toBe(280);
  });
});

describe("storedNavigationWidth", () => {
  it("accepts a stored width and rejects invalid or empty values", () => {
    expect(storedNavigationWidth("520", 1200)).toBe(520);
    expect(storedNavigationWidth("invalid", 1200)).toBe(360);
    expect(storedNavigationWidth("   ", 1200)).toBe(360);
    expect(storedNavigationWidth(null, 800)).toBe(280);
  });

  it("re-clamps a stored width for a narrower viewport", () => {
    expect(storedNavigationWidth("900", 1000)).toBe(640);
  });
});

describe("storage helpers", () => {
  // vitest's node environment has no localStorage - a tiny in-memory stub
  // is enough to exercise the persistence logic.
  class MemoryStorage {
    private readonly store = new Map<string, string>();

    getItem(key: string) {
      return this.store.get(key) ?? null;
    }

    setItem(key: string, value: string) {
      this.store.set(key, value);
    }
  }

  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips a width through storage", () => {
    persistNavigationWidth(400);
    expect(localStorage.getItem(NAVIGATION_WIDTH_STORAGE_KEY)).toBe("400");
    expect(readStoredNavigationWidth(1200)).toBe(400);
  });

  it("returns the responsive default when nothing was stored", () => {
    expect(readStoredNavigationWidth(1400)).toBe(360);
  });

  it("falls back to the default when storage throws on read", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
    });
    expect(readStoredNavigationWidth(1400)).toBe(360);
  });

  it("does not throw when storage is unavailable on write", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("storage disabled");
      },
    });
    expect(() => {
      persistNavigationWidth(400);
    }).not.toThrow();
  });
});
