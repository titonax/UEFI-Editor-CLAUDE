import { describe, expect, it } from "vitest";
import { decodeControlFlags, describeControlFlags, hiddenBySetupData } from "./setupDataFlags";

describe("decodeControlFlags", () => {
  it("decodes the values seen in the reference images", () => {
    expect(decodeControlFlags("01")).toMatchObject({ shown: true, interactive: false, refreshOrAccess: false, unresolved: [] });
    expect(decodeControlFlags("09")).toMatchObject({ shown: true, interactive: true, refreshOrAccess: false });
    expect(decodeControlFlags("29")).toMatchObject({ shown: true, interactive: true, refreshOrAccess: true });
    expect(decodeControlFlags("49")).toMatchObject({ shown: true, interactive: true, unresolved: [6] });
  });

  it("treats a clear bit 0 as hidden by SetupData and anything else as shown", () => {
    expect(hiddenBySetupData("00")).toBe(true);
    expect(hiddenBySetupData("08")).toBe(true);
    expect(hiddenBySetupData("01")).toBe(false);
    expect(hiddenBySetupData(null)).toBe(false);
    expect(hiddenBySetupData("zz")).toBe(false);
  });

  it("describes the flags for the access-level field", () => {
    expect(describeControlFlags("29")).toBe(
      "SetupData control flags 0x29: shown, interactive, refresh / access (tentative). Bit 0 is the Show/Hide switch; clearing it hides the item in SetupData without touching the IFR.",
    );
    expect(describeControlFlags("00")).toContain("no flag set");
    expect(describeControlFlags(null)).toBe("No SetupData control record was matched for this item.");
  });
});
