import { describe, expect, it } from "vitest";
import { caseFilePath, caseFromEntry, serializeCase } from "./caseFromEntry";
import { validateFirmwareCase } from "./schema";
import type { CorpusRunEntry } from "../components/scripts/corpusDashboard";

const sha = "5b3829c0".padEnd(64, "1");

function entry(overrides: Partial<CorpusRunEntry> = {}): CorpusRunEntry {
  return {
    fileName: "board.bin",
    size: 16777216,
    sha256: sha,
    status: "partial",
    container: "intel-flash",
    generation: { generation: "unresolved", confidence: "unresolved", conflict: false },
    contextCount: 2,
    volumes: { firmwareVolumes: 5, ffs2Volumes: 5, ffs3Volumes: 0, directSetupFiles: 0 },
    reconstructionBlockers: ["compressed-uefi-rebuild"],
    stages: [
      { id: "preflight", status: "passed", detail: "5 firmware volume(s), intel-flash." },
      { id: "extraction", status: "passed", detail: "2 coherent context(s)." },
      { id: "hii", status: "passed", detail: "8 FormSets" },
      { id: "navigation", status: "warning", detail: "unresolved" },
    ],
    vendorGuess: { family: "ami-aptio", label: "AMI Aptio", evidence: ["AMITSE GUID"] },
    ...overrides,
  };
}

describe("caseFromEntry", () => {
  it("turns an analysed image into a valid case without any firmware bytes", () => {
    const result = caseFromEntry(entry());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateFirmwareCase(result.value).ok).toBe(true);
    expect(result.value).toMatchObject({
      schemaVersion: 1,
      id: "ami-5b3829c0",
      sha256: sha,
      size: 16777216,
      names: ["board.bin"],
      vendorFamily: "ami-aptio",
      container: "intel-flash",
      generation: "unresolved",
      generationEvidence: "unresolved",
      source: "corpus-runner",
    });
    expect(result.value.features).toMatchObject({
      firmwareVolumes: 5,
      ffs2Volumes: 5,
      ffs3Volumes: 0,
      directSetupFiles: 0,
      contextCount: 2,
    });
    expect(result.value.stages).toEqual({
      preflight: "passed",
      extraction: "passed",
      hii: "passed",
      navigation: "warning",
    });
    expect(result.value.blockers).toEqual(["compressed-uefi-rebuild"]);
  });

  it("records the HII counts and the navigation mechanism when the run got that far", () => {
    const result = caseFromEntry(
      entry({
        report: {
          label: "board.bin",
          firmwareFamily: "ami-aptio",
          counts: { formSets: 8, forms: 120, refs: 300, conditions: 40 },
          navigation: {
            status: "detected",
            mechanism: "single-formset-hub",
            directTabs: 6,
            suppressedTabs: 0,
            descendants: 0,
            registeredOnly: 0,
          },
          tabOperations: [],
        },
      }),
    );

    expect(result.ok && result.value.features).toMatchObject({
      formSets: 8,
      forms: 120,
      refs: 300,
      navigation: "single-formset-hub",
    });
  });

  it("omits what was never observed instead of guessing", () => {
    const result = caseFromEntry(
      entry({
        volumes: undefined,
        container: undefined,
        vendorGuess: undefined,
        generation: undefined,
        stages: [],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vendorFamily).toBe("unknown");
    expect(result.value.container).toBe("unknown");
    expect(result.value.generation).toBe("unresolved");
    expect(result.value.features.firmwareVolumes).toBeUndefined();
    expect(result.value.stages).toBeUndefined();
  });

  it("refuses an image that could not be hashed, since the hash is the case's identity", () => {
    const result = caseFromEntry(entry({ sha256: "" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/SHA-256/);
  });

  it("keeps a reported generation conflict visible instead of settling it", () => {
    const result = caseFromEntry(
      entry({ generation: { generation: "aptio-iv", confidence: "probable", conflict: true } }),
    );

    expect(result.ok && result.value.blockers).toContain("generation-conflict");
    expect(result.ok && result.value.generation).toBe("unresolved");
  });

  it("never claims a resolved generation without evidence", () => {
    const result = caseFromEntry(
      entry({ generation: { generation: "aptio-v", confidence: "unresolved", conflict: false } }),
    );

    expect(result.ok && result.value.generation).toBe("unresolved");
  });

  it("keeps long text within the schema limit and records the failure reason as a note", () => {
    const result = caseFromEntry(
      entry({
        status: "failed",
        fileName: "x".repeat(300) + ".bin",
        failureMessage: "No valid UEFI firmware volumes were found. " + "y".repeat(400),
        reconstructionBlockers: ["z".repeat(500)],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.names[0].length).toBeLessThanOrEqual(200);
    expect(result.value.blockers[0].length).toBeLessThanOrEqual(200);
    expect(result.value.notes?.[0]).toMatch(/^Failure: No valid UEFI/);
  });

  it("uses the vendor family as the id prefix, with the AMI family shortened to ami", () => {
    const award = caseFromEntry(entry({ vendorGuess: { family: "award", label: "Award", evidence: [] } }));
    expect(award.ok && award.value.id).toBe("award-5b3829c0");
  });
});

describe("serializeCase and caseFilePath", () => {
  it("writes stable, human-diffable JSON that validates when read back", () => {
    const result = caseFromEntry(entry());
    if (!result.ok) throw new Error("expected a case");

    const text = serializeCase(result.value);

    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "id": "ami-5b3829c0"');
    expect(validateFirmwareCase(JSON.parse(text)).ok).toBe(true);
  });

  it("names the file after the id, under a directory for the family", () => {
    const result = caseFromEntry(entry());
    if (!result.ok) throw new Error("expected a case");

    expect(caseFilePath(result.value)).toBe("src/knowledge/cases/ami/ami-5b3829c0.json");
  });
});
