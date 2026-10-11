import { describe, expect, it } from "vitest";
import { inspectAmiRootVisibility } from "./amiRootVisibility";
import type { FirmwareProvenanceGraph } from "./firmwareProvenance";
import type { Menu } from "./types";
import { buildPe } from "./rootVectorFixtures";

function writeUint24(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

function graph(pe: Uint8Array): FirmwareProvenanceGraph {
  const section = new Uint8Array(pe.length + 4);
  writeUint24(section, 0, section.length);
  section[3] = 0x10;
  section.set(pe, 4);
  return {
    rootBufferId: 0,
    sourceSize: 0x1000,
    buffers: [
      { id: 0, bytes: new Uint8Array(0x1000), depth: 0 },
      { id: 1, bytes: section, depth: 1 },
    ],
    artifacts: [
      {
        kind: "setup-hii",
        bufferId: 1,
        payloadStart: 0,
        payloadEnd: section.length,
        sourceFile: {
          bufferId: 0,
          guid: "899407D7-99FE-43D8-9A21-79EC328CAC21",
          volumeStart: 0,
          volumeEnd: 0x1000,
          fileStart: 0x100,
          bodyStart: 0x118,
          end: 0x900,
          headerSize: 24,
        },
      },
    ],
  };
}

function roots(count: number): Menu {
  return Array.from({ length: count }, (_, index) => ({
    name: `Root ${String(index)}`,
    formId: `0x${String(index + 1)}`,
    formSetGuid: `0000000${String(index)}-0000-0000-0000-000000000000`,
    offset: null,
    source: "formset" as const,
  }));
}

describe("inspectAmiRootVisibility", () => {
  it("maps a code-referenced byte vector to IFR FormSet order", () => {
    const report = inspectAmiRootVisibility(roots(3), graph(buildPe([1, 0, 1])));

    expect(report.status).toBe("detected");
    expect(report.vector).toMatchObject({
      bufferId: 1,
      offset: 4 + 0x680,
      length: 3,
      codeReferenceOffset: 4 + 0x220,
      pageTableOffset: 4 + 0x700,
      countEvidence: "immediate",
    });
    expect(report.entries).toEqual([
      expect.objectContaining({ rootIndex: 0, value: 1, visible: true, bufferOffset: 4 + 0x680 }),
      expect.objectContaining({ rootIndex: 1, value: 0, visible: false, bufferOffset: 4 + 0x681 }),
      expect.objectContaining({ rootIndex: 2, value: 1, visible: true, bufferOffset: 4 + 0x682 }),
    ]);
  });

  it("accepts a root count loaded from validated PE data", () => {
    const report = inspectAmiRootVisibility(
      roots(3),
      graph(buildPe([1, 1, 1], { dynamicCount: true })),
    );

    expect(report.status).toBe("detected");
    expect(report.vector?.countEvidence).toBe("data");
  });

  it("does not infer polarity from an all-zero or non-Boolean array", () => {
    expect(inspectAmiRootVisibility(roots(3), graph(buildPe([0, 0, 0]))).status).toBe(
      "unresolved",
    );
    expect(inspectAmiRootVisibility(roots(3), graph(buildPe([1, 2, 1]))).status).toBe(
      "unresolved",
    );
  });

  it("stays unresolved when the loop count disagrees with the FormSet count", () => {
    expect(inspectAmiRootVisibility(roots(4), graph(buildPe([1, 0, 1]))).status).toBe(
      "unresolved",
    );
  });

  it("rejects multiple matching vectors instead of choosing one", () => {
    const report = inspectAmiRootVisibility(
      roots(3),
      graph(buildPe([1, 0, 1], { secondVector: [1, 1, 0] })),
    );

    expect(report.status).toBe("ambiguous");
    expect(report.reason).toBe("2 code-referenced vectors matched; no root state was selected.");
    expect(report.entries).toEqual([]);
  });

  it("reports a single-FormSet layout without inferring an Aptio generation", () => {
    const report = inspectAmiRootVisibility(roots(1), {
      rootBufferId: 0,
      sourceSize: 0,
      buffers: [],
      artifacts: [],
    });

    expect(report.status).toBe("not-applicable");
    expect(report.reason).toContain("does not identify or exclude an Aptio generation");
  });

  it("is unresolved without a Setup HII provenance branch", () => {
    const report = inspectAmiRootVisibility(roots(2), {
      rootBufferId: 0,
      sourceSize: 0,
      buffers: [],
      artifacts: [],
    });

    expect(report.status).toBe("unresolved");
    expect(report.reason).toBe("The Setup HII provenance branch is incomplete.");
  });
});
