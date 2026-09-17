import { describe, expect, it } from "vitest";
import { inspectAmiRootVisibility } from "./amiRootVisibility";
import type { FirmwareProvenanceGraph } from "./firmwareProvenance";
import type { Menu } from "./types";

const IMAGE_BASE = 0x180000000;

function writeUint24(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

function writeName(bytes: Uint8Array, offset: number, value: string) {
  bytes.set(new TextEncoder().encode(value), offset);
}

function writeRipDisplacement(view: DataView, instructionOffset: number, targetRva: number) {
  view.setInt32(instructionOffset + 3, targetRva - (instructionOffset + 7), true);
}

// A synthetic x86-64 PE32+ with a .text section holding the root-vector
// loop (lea rbx, [vector]; lea rdi, [table]; cmp byte [rbx], 0; jne; inc
// rbx; add rdi, 0x20; sub rsi, 1; jne back) and a .data section holding
// the vector and the page table. Raw offsets equal RVAs, which keeps the
// RIP-relative arithmetic readable.
function buildPe(
  values: number[],
  options: { dynamicCount?: boolean; secondVector?: number[] } = {},
) {
  const bytes = new Uint8Array(0x900);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x5a], 0);
  view.setUint32(0x3c, 0x80, true);
  bytes.set([0x50, 0x45, 0, 0], 0x80);
  view.setUint16(0x84, 0x8664, true);
  view.setUint16(0x86, 2, true);
  view.setUint16(0x94, 0xf0, true);
  view.setUint16(0x98, 0x20b, true);
  view.setBigUint64(0xb0, BigInt(IMAGE_BASE), true);

  const textHeader = 0x188;
  writeName(bytes, textHeader, ".text");
  view.setUint32(textHeader + 8, 0x200, true);
  view.setUint32(textHeader + 12, 0x200, true);
  view.setUint32(textHeader + 16, 0x200, true);
  view.setUint32(textHeader + 20, 0x200, true);
  view.setUint32(textHeader + 36, 0x60000020, true);

  const dataHeader = textHeader + 40;
  writeName(bytes, dataHeader, ".data");
  view.setUint32(dataHeader + 8, 0x300, true);
  view.setUint32(dataHeader + 12, 0x600, true);
  view.setUint32(dataHeader + 16, 0x300, true);
  view.setUint32(dataHeader + 20, 0x600, true);
  view.setUint32(dataHeader + 36, 0xc0000040, true);

  function writeLoop(
    codeOffset: number,
    vectorOffset: number,
    tableOffset: number,
    loopValues: number[],
    dynamicCount: boolean,
  ) {
    if (dynamicCount) {
      const countOffset = 0x6f0;
      view.setUint32(countOffset, loopValues.length, true);
      bytes.set([0x8b, 0x05, 0, 0, 0, 0], codeOffset - 8);
      view.setInt32(codeOffset - 6, countOffset - (codeOffset - 8 + 6), true);
    } else {
      bytes[codeOffset - 8] = 0xbe;
      view.setUint32(codeOffset - 7, loopValues.length, true);
    }

    bytes.set([0x48, 0x8d, 0x1d, 0, 0, 0, 0], codeOffset);
    writeRipDisplacement(view, codeOffset, vectorOffset);
    bytes.set([0x48, 0x8d, 0x3d, 0, 0, 0, 0], codeOffset + 7);
    writeRipDisplacement(view, codeOffset + 7, tableOffset);
    bytes.set(
      [
        0x80, 0x3b, 0x00, 0x75, 0x08, 0x48, 0xff, 0xc3, 0x48, 0x83, 0xc7, 0x20, 0x48,
        0x83, 0xee, 0x01, 0x75, 0xee,
      ],
      codeOffset + 14,
    );
    bytes.set(loopValues, vectorOffset);
  }

  writeLoop(0x220, 0x680, 0x700, values, options.dynamicCount ?? false);
  if (options.secondVector) {
    writeLoop(0x280, 0x6c0, 0x780, options.secondVector, false);
  }
  return bytes;
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
