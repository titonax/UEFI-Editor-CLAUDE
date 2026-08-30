import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NAVBAR_WIDTH,
  MAX_NAVBAR_WIDTH,
  MIN_NAVBAR_WIDTH,
  loadNavbarWidth,
  saveNavbarWidth,
} from "./navbarWidth";

// vitest's "node" test environment has no real localStorage, and this
// project has no jsdom dependency - a tiny in-memory stub is enough to
// exercise the persistence logic without pulling one in.
class MemoryStorage {
  private store = new Map<string, string>();

  getItem(key: string) {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
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

describe("loadNavbarWidth", () => {
  it("returns the default when nothing was saved", () => {
    expect(loadNavbarWidth()).toBe(DEFAULT_NAVBAR_WIDTH);
  });

  it("returns a previously saved, in-range width", () => {
    saveNavbarWidth(400);
    expect(loadNavbarWidth()).toBe(400);
  });

  it("clamps a saved width below the minimum", () => {
    localStorage.setItem("uefi-editor:navbar-width", "10");
    expect(loadNavbarWidth()).toBe(MIN_NAVBAR_WIDTH);
  });

  it("clamps a saved width above the maximum", () => {
    localStorage.setItem("uefi-editor:navbar-width", "5000");
    expect(loadNavbarWidth()).toBe(MAX_NAVBAR_WIDTH);
  });

  it("falls back to the default for garbage stored data", () => {
    localStorage.setItem("uefi-editor:navbar-width", "not-a-number");
    expect(loadNavbarWidth()).toBe(DEFAULT_NAVBAR_WIDTH);
  });

  it("falls back to the default when localStorage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
    });
    expect(loadNavbarWidth()).toBe(DEFAULT_NAVBAR_WIDTH);
  });
});

describe("saveNavbarWidth", () => {
  it("clamps before persisting", () => {
    saveNavbarWidth(MAX_NAVBAR_WIDTH + 500);
    expect(loadNavbarWidth()).toBe(MAX_NAVBAR_WIDTH);
  });

  it("does not throw when localStorage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("storage disabled");
      },
    });
    expect(() => {
      saveNavbarWidth(400);
    }).not.toThrow();
  });
});
