import { describe, expect, it } from "vitest";
import { knownCases, loadCases } from "./index";
import sampleCorpusDoc from "../../docs/ami/sample-corpus.md?raw";

describe("bundled firmware cases", () => {
  it("loads, validates and has one case per image", () => {
    expect(knownCases.length).toBeGreaterThan(0);
    expect(new Set(knownCases.map((entry) => entry.sha256)).size).toBe(knownCases.length);
  });

  it("records the byte-identical image2.bin and image3.bin as a single case", () => {
    const image = knownCases.find((entry) => entry.names.includes("image2.bin"));
    expect(image?.names).toEqual(["image2.bin", "image3.bin"]);
    expect(image?.sha256).toBe("56430f2f4f9aef4e50f503dc8397fdb20b005bf38a8b9029c43e3eed56c39229");
  });

  it("never turns a vendor family into a generation verdict", () => {
    for (const entry of knownCases) {
      if (entry.generation === "unresolved") expect(entry.generationEvidence).toBe("unresolved");
    }
  });

  it("stays in step with the sample table in docs/ami/sample-corpus.md", () => {
    const doc: string = sampleCorpusDoc;
    const documented = new Set([...doc.matchAll(/`([0-9a-f]{64})`/g)].map((match) => match[1]));
    // The doc also lists the three extracted artifacts of image2.bin; the
    // image-level hashes are the ones that name a case.
    for (const entry of knownCases) expect(documented.has(entry.sha256)).toBe(true);
    const imageRows = doc
      .split("\n")
      .filter((line) => /^\|\s*`[^`]+`\s*\|\s*[\d,]+\s*\|/.test(line))
      .map((line) => /`([0-9a-f]{64})`/.exec(line)?.[1]);
    expect(new Set(imageRows)).toEqual(new Set(knownCases.map((entry) => entry.sha256)));
  });

  it("fails loudly on an invalid or duplicated case", () => {
    expect(() => loadCases({ "./bad.json": { id: "x" } })).toThrow(/Invalid firmware case \.\/bad\.json/);
    const first = knownCases[0];
    expect(() => loadCases({ "./a.json": first, "./b.json": first })).toThrow(/collection/);
  });
});
