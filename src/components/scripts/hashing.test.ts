import { describe, expect, it, vi } from "vitest";
import { calculateJsonChecksum, sha256Hex } from "./hashing";

describe("sha256Hex", () => {
  it("hashes normally when crypto.subtle resolves", async () => {
    const hex = await sha256Hex(new TextEncoder().encode("hello"));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws a diagnosable error instead of hanging forever when crypto.subtle.digest never resolves", async () => {
    vi.useFakeTimers();
    const digestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockReturnValue(new Promise<ArrayBuffer>(() => undefined));

    const pending = sha256Hex(new TextEncoder().encode("hello"));
    const assertion = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    digestSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe("calculateJsonChecksum", () => {
  it("is deterministic for the same inputs", async () => {
    const menu = [{ name: "Main", formId: "0x1", offset: "0x10" }];
    const forms = [
      {
        name: "Main",
        type: "Form" as const,
        formId: "0x1",
        referencedIn: [],
        children: [],
      },
    ];
    const first = await calculateJsonChecksum(menu, forms, []);
    const second = await calculateJsonChecksum(menu, forms, []);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when an offset changes", async () => {
    const forms = [
      {
        name: "Main",
        type: "Form" as const,
        formId: "0x1",
        referencedIn: [],
        children: [],
      },
    ];
    const before = await calculateJsonChecksum(
      [{ name: "Main", formId: "0x1", offset: "0x10" }],
      forms,
      [],
    );
    const after = await calculateJsonChecksum(
      [{ name: "Main", formId: "0x1", offset: "0x12" }],
      forms,
      [],
    );
    expect(before).not.toBe(after);
  });
});
