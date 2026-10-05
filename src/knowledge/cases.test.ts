import { describe, expect, it } from "vitest";
import { caseFilePath, caseFromEntry } from "./caseFromEntry";
import { knownCases, loadCases } from "./index";
import { caseDirectory } from "./schema";
import type { CorpusRunEntry } from "../components/scripts/corpusDashboard";
import sampleCorpusDoc from "../../docs/ami/sample-corpus.md?raw";
import crossVendorDoc from "../../docs/aptio-iv/samples/cross-vendor-intake.md?raw";
import hpBoaDoc from "../../docs/aptio-iv/samples/hp-boa-8005.md?raw";
import hpIpisbDoc from "../../docs/aptio-iv/samples/hp-ipisb-ch2-w25q32.md?raw";
import hpServerDoc from "../../docs/aptio-iv/samples/hp-server-l01-0278.md?raw";
import supermicroDoc from "../../docs/aptio-iv/samples/supermicro-x9dr3-if-34.md?raw";

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
    // Cases recorded from that table must match it. Cases recorded elsewhere
    // (for example by the corpus runner) are not described by this document.
    const fromDoc = knownCases.filter((entry) => entry.source === "docs/ami/sample-corpus.md");
    expect(fromDoc.length).toBeGreaterThan(0);
    for (const entry of fromDoc) expect(documented.has(entry.sha256)).toBe(true);
    const imageRows = doc
      .split("\n")
      .filter((line) => /^\|\s*`[^`]+`\s*\|\s*[\d,]+\s*\|/.test(line))
      .map((line) => /`([0-9a-f]{64})`/.exec(line)?.[1]);
    // The doc also lists the three extracted artifacts of image2.bin; the
    // image rows are the ones that name a case.
    expect(new Set(imageRows)).toEqual(new Set(fromDoc.map((entry) => entry.sha256)));
  });

  it("stays in step with the Aptio IV sample records in docs/aptio-iv/samples", () => {
    const docs: Record<string, string> = {
      "docs/aptio-iv/samples/cross-vendor-intake.md": crossVendorDoc,
      "docs/aptio-iv/samples/hp-boa-8005.md": hpBoaDoc,
      "docs/aptio-iv/samples/hp-ipisb-ch2-w25q32.md": hpIpisbDoc,
      "docs/aptio-iv/samples/hp-server-l01-0278.md": hpServerDoc,
      "docs/aptio-iv/samples/supermicro-x9dr3-if-34.md": supermicroDoc,
    };
    const fromDocs = knownCases.filter((entry) => entry.source.startsWith("docs/aptio-iv/samples/"));
    expect(fromDocs).toHaveLength(10);
    for (const entry of fromDocs) {
      const doc = docs[entry.source] as string | undefined;
      expect(doc, `${entry.id}: ${entry.source} is not a known sample record`).toBeDefined();
      expect(doc?.includes(entry.sha256), `${entry.id}: SHA-256 is not in ${entry.source}`).toBe(true);
    }
  });

  it("does not resolve the Aptio generation from a sample record alone", () => {
    // The records call these images Aptio IV, but they rest on structures the
    // IV and V corpora share; the generation stays unresolved (see
    // docs/ami/sample-corpus.md) and the documented claim is kept as a note.
    for (const entry of knownCases.filter((one) => one.source.startsWith("docs/aptio-iv/samples/"))) {
      expect(entry.generation, entry.id).toBe("unresolved");
      expect(entry.notes?.join(" "), entry.id).toMatch(/Aptio IV/);
    }
  });

  it("keeps every case file at cases/<family>/<id>.json", () => {
    const first = knownCases[0];
    const rightPlace = `./cases/ami/${first.id}.json`;

    expect(() => loadCases({ [rightPlace]: first })).not.toThrow();
    expect(() => loadCases({ "./cases/ami/renamed.json": first })).toThrow(/misplaced: expected \.\/cases\/ami\//);
    expect(() => loadCases({ [`./cases/award/${first.id}.json`]: first })).toThrow(/misplaced/);
  });

  it("accepts a case produced by the corpus runner at the path it advertises", () => {
    const entry: CorpusRunEntry = {
      fileName: "new-board.bin",
      size: 16777216,
      sha256: "9".repeat(64),
      status: "partial",
      container: "vendor-image",
      generation: { generation: "unresolved", confidence: "unresolved", conflict: false },
      contextCount: 1,
      volumes: { firmwareVolumes: 3, ffs2Volumes: 3, ffs3Volumes: 0, directSetupFiles: 1 },
      reconstructionBlockers: [],
      stages: [{ id: "preflight", status: "passed", detail: "" }],
      vendorGuess: { family: "ami-aptio", label: "AMI Aptio", evidence: [] },
    };
    const produced = caseFromEntry(entry);
    if (!produced.ok) throw new Error(produced.errors.join(" "));
    const advertised = `./${caseFilePath(produced.value).replace("src/knowledge/", "")}`;
    const bundled = Object.fromEntries(
      knownCases.map((entry) => [`./cases/${caseDirectory(entry.vendorFamily)}/${entry.id}.json`, entry]),
    );

    const loaded = loadCases({ ...bundled, [advertised]: produced.value });

    expect(loaded).toHaveLength(knownCases.length + 1);
    expect(loaded.some((entry) => entry.id === produced.value.id)).toBe(true);
  });

  it("fails loudly on an invalid or duplicated case", () => {
    expect(() => loadCases({ "./bad.json": { id: "x" } })).toThrow(/Invalid firmware case \.\/bad\.json/);
    const first = knownCases[0];
    expect(() => loadCases({ "./a.json": first, "./b.json": first })).toThrow(/collection/);
  });
});
