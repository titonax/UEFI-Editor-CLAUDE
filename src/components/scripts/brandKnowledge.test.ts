import { describe, expect, it } from "vitest";
import { classifyBrand, compareBrandNavigation, supportedBrands } from "./brandKnowledge";

describe("classifyBrand", () => {
  it("recognizes a documented sample by its exact SHA-256, ahead of any other signal", () => {
    const classification = classifyBrand(
      "unrelated.bin",
      "12770CBDDBAB0FD071E91142AFE6B1882C7A50C0E7B438866F6B99B5C660DA64",
      [{ brand: "HP", marker: "SECURE_HP_SIGNATURE", offset: 0x10 }],
    );

    expect(classification.brand).toBe("Intel");
    expect(classification.basis).toBe("documented-hash");
    expect(classification.documentedSamples).toBe(1);
    expect(classification.observedContainers).toEqual([
      { container: "firmware-volume-image", samples: 1 },
    ]);
    expect(classification.navigationPrior).toEqual([
      { mechanism: "single-formset-ifr-hub", samples: 1 },
    ]);
  });

  it("prefers a firmware-marker byte match over a filename token", () => {
    const classification = classifyBrand(
      "definitely-an-asus-board.bin",
      "",
      [{ brand: "HP", marker: "SECURE_HP_SIGNATURE", offset: 0x10 }],
    );

    expect(classification.brand).toBe("HP");
    expect(classification.basis).toBe("firmware-marker");
  });

  it("falls back to a filename token when nothing stronger is available", () => {
    const classification = classifyBrand("MSI-Z270-Tomahawk.bin", "", []);

    expect(classification.brand).toBe("MSI");
    expect(classification.basis).toBe("filename");
    expect(classification.documentedSamples).toBe(2);
  });

  it("leaves the brand unresolved when two markers at the same (strongest) precedence disagree", () => {
    const classification = classifyBrand(
      "board.bin",
      "",
      [
        { brand: "HP", marker: "SECURE_HP_SIGNATURE", offset: 0x10 },
        { brand: "ASUS", marker: "ASUSTeK COMPUTER INC.", offset: 0x40 },
      ],
    );

    expect(classification.brand).toBeNull();
    expect(classification.basis).toBe("conflict");
  });

  it("reports no documented samples and an unknown basis with no signal at all", () => {
    const classification = classifyBrand("firmware.bin", "", []);

    expect(classification.brand).toBeNull();
    expect(classification.basis).toBe("unknown");
    expect(classification.documentedSamples).toBe(0);
    expect(classification.signals).toEqual([]);
  });

  it("lists all eight supported brands", () => {
    expect(supportedBrands).toHaveLength(8);
    expect(supportedBrands).toContain("Intel");
  });
});

describe("compareBrandNavigation", () => {
  it("marks a matching outcome when the observed mechanism was already documented for the brand", () => {
    const classification = classifyBrand(
      "",
      "12770cbddbab0fd071e91142afe6b1882c7a50c0e7b438866f6b99b5c660da64",
      [],
    );

    const compared = compareBrandNavigation(classification, ["single-formset-ifr-hub"]);

    expect(compared.navigationOutcome).toBe("matches-prior");
  });

  it("marks a new-pattern outcome when the observed mechanism was never documented for the brand", () => {
    const classification = classifyBrand(
      "",
      "12770cbddbab0fd071e91142afe6b1882c7a50c0e7b438866f6b99b5c660da64",
      [],
    );

    const compared = compareBrandNavigation(classification, ["multi-formset-root-vector"]);

    expect(compared.navigationOutcome).toBe("new-pattern");
  });

  it("stays unmeasured when the brand has no documented navigation prior", () => {
    const classification = classifyBrand("ASRock-board.bin", "", []);

    const compared = compareBrandNavigation(classification, ["single-formset-ifr-hub"]);

    expect(compared.navigationOutcome).toBe("unmeasured");
  });

  it("stays unmeasured when nothing was actually observed on this image", () => {
    const classification = classifyBrand(
      "",
      "12770cbddbab0fd071e91142afe6b1882c7a50c0e7b438866f6b99b5c660da64",
      [],
    );

    const compared = compareBrandNavigation(classification, ["unresolved"]);

    expect(compared.navigationOutcome).toBe("unmeasured");
  });
});
