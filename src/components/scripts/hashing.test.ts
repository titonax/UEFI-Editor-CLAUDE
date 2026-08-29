import { describe, expect, it } from "vitest";
import { calculateJsonChecksum } from "./hashing";

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
