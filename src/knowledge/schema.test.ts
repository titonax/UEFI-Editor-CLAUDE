import { describe, expect, it } from "vitest";
import { findCollectionProblems, validateFirmwareCase, type FirmwareCase } from "./schema";

const sha = "56430f2f4f9aef4e50f503dc8397fdb20b005bf38a8b9029c43e3eed56c39229";

function validCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "ami-56430f2f",
    sha256: sha,
    size: 33554432,
    names: ["image2.bin"],
    vendorFamily: "ami-aptio",
    container: "intel-flash",
    generation: "unresolved",
    generationEvidence: "unresolved",
    features: { firmwareVolumes: 12, ffs2Files: 12, ffs3Files: 0, directSetupFiles: 0 },
    blockers: [],
    source: "docs/ami/sample-corpus.md",
    ...overrides,
  };
}

function errorsFor(value: unknown) {
  const result = validateFirmwareCase(value);
  return result.ok ? [] : result.errors;
}

describe("validateFirmwareCase", () => {
  it("accepts a well-formed case", () => {
    expect(validateFirmwareCase(validCase()).ok).toBe(true);
  });

  it("accepts stages, notes and a navigation feature", () => {
    const result = validateFirmwareCase(
      validCase({
        stages: { preflight: "passed", hii: "warning" },
        notes: ["observed twice"],
        features: { navigation: "single-formset-hub", forms: 4 },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects anything that is not an object", () => {
    expect(errorsFor(null)).not.toHaveLength(0);
    expect(errorsFor([])).not.toHaveLength(0);
  });

  it("rejects unknown fields so firmware bytes cannot ride along", () => {
    expect(errorsFor(validCase({ bytes: "DEADBEEF" })).join(" ")).toMatch(/Unknown field "bytes"/);
    expect(errorsFor(validCase({ features: { rawBytes: 1 } })).join(" ")).toMatch(/Unknown feature "rawBytes"/);
  });

  it("rejects a malformed or mismatched identity", () => {
    expect(errorsFor(validCase({ sha256: "ABC" })).join(" ")).toMatch(/sha256/);
    expect(errorsFor(validCase({ sha256: sha.toUpperCase() })).join(" ")).toMatch(/sha256/);
    expect(errorsFor(validCase({ id: "ami-00000000" })).join(" ")).toMatch(/id must end with/);
    expect(errorsFor(validCase({ id: "Not An Id" })).join(" ")).toMatch(/id must look like/);
  });

  it("rejects bad sizes, counts and empty names", () => {
    expect(errorsFor(validCase({ size: 0 })).join(" ")).toMatch(/size/);
    expect(errorsFor(validCase({ features: { forms: -1 } })).join(" ")).toMatch(/"forms"/);
    expect(errorsFor(validCase({ features: { forms: 1.5 } })).join(" ")).toMatch(/"forms"/);
    expect(errorsFor(validCase({ names: [] })).join(" ")).toMatch(/names/);
  });

  it("rejects values outside the known vocabularies", () => {
    expect(errorsFor(validCase({ vendorFamily: "asus" })).join(" ")).toMatch(/vendorFamily/);
    expect(errorsFor(validCase({ container: "tape" })).join(" ")).toMatch(/container/);
    expect(errorsFor(validCase({ stages: { boot: "passed" } })).join(" ")).toMatch(/Unknown stage/);
    expect(errorsFor(validCase({ stages: { hii: "great" } })).join(" ")).toMatch(/unknown status/);
  });

  it("rejects text long enough to hide binary data", () => {
    expect(errorsFor(validCase({ notes: ["A".repeat(201)] })).join(" ")).toMatch(/notes/);
  });

  it("keeps generation and its evidence consistent", () => {
    expect(
      errorsFor(validCase({ generation: "aptio-v", generationEvidence: "unresolved" })).join(" "),
    ).toMatch(/needs evidence/);
    expect(
      errorsFor(validCase({ generation: "unresolved", generationEvidence: "confirmed" })).join(" "),
    ).toMatch(/cannot claim evidence/);
    expect(
      validateFirmwareCase(validCase({ generation: "aptio-v", generationEvidence: "probable" })).ok,
    ).toBe(true);
  });
});

describe("findCollectionProblems", () => {
  const first = validCase() as unknown as FirmwareCase;

  it("reports nothing for distinct cases", () => {
    const other = validCase({ id: "ami-aaaaaaaa", sha256: "a".repeat(64) }) as unknown as FirmwareCase;
    expect(findCollectionProblems([first, other])).toEqual([]);
  });

  it("reports two cases for the same image and repeated ids", () => {
    const sameImage = validCase({ id: "ami-56430f2f" }) as unknown as FirmwareCase;
    const problems = findCollectionProblems([first, sameImage]).join(" ");
    expect(problems).toMatch(/Duplicate id/);
    expect(problems).toMatch(/same image/);
  });
});
