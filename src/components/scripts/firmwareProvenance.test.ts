import { describe, expect, it } from "vitest";
import {
  assessFirmwareReconstruction,
  type FirmwareProvenanceGraph,
} from "./firmwareProvenance";

function traceableGraph(): FirmwareProvenanceGraph {
  return {
    rootBufferId: 0,
    sourceSize: 0x1000,
    buffers: [
      { id: 0, bytes: new Uint8Array(0x1000), depth: 0 },
      {
        id: 4,
        bytes: new Uint8Array(0x300),
        depth: 1,
        parent: {
          parentBufferId: 0,
          sectionStart: 0x100,
          sectionEnd: 0x500,
          sectionHeaderSize: 4,
          sectionType: 2,
          payloadStart: 0x118,
          payloadEnd: 0x500,
          compression: "lzma",
        },
      },
      {
        id: 9,
        bytes: new Uint8Array(0x180),
        depth: 2,
        parent: {
          parentBufferId: 4,
          sectionStart: 0x20,
          sectionEnd: 0x200,
          sectionHeaderSize: 4,
          sectionType: 1,
          payloadStart: 0x29,
          payloadEnd: 0x200,
          compression: "standard",
        },
      },
    ],
    artifacts: [
      {
        kind: "setup-hii",
        bufferId: 9,
        payloadStart: 0x30,
        payloadEnd: 0x90,
        sourceFile: {
          bufferId: 4,
          guid: "899407D7-99FE-43D8-9A21-79EC328CAC21",
          volumeStart: 0,
          volumeEnd: 0x300,
          fileStart: 8,
          bodyStart: 0x20,
          end: 0x240,
          headerSize: 24,
        },
      },
    ],
  };
}

describe("assessFirmwareReconstruction", () => {
  it("walks sparse buffer ids back to the source image and lists every blocker", () => {
    const assessment = assessFirmwareReconstruction(traceableGraph());

    expect(assessment.traceComplete).toBe(true);
    expect(assessment.writeEnabled).toBe(false);
    expect(assessment.compressions).toEqual(["lzma", "standard"]);
    expect(assessment.traces[0].labels).toEqual([
      "Firmware image",
      "LZMA section @ 0x100",
      "EFI/Tiano section @ 0x20",
      "Setup HII",
    ]);
    expect(assessment.blockers).toEqual([
      "Deterministic LZMA recompression is not implemented yet.",
      "Deterministic EFI/Tiano recompression is not implemented yet.",
      "Bottom-up section replacement, FFS checksum repair and full re-extraction verification are not implemented yet.",
    ]);
  });

  it("refuses a path whose parent buffer is missing", () => {
    const graph = traceableGraph();
    graph.buffers = graph.buffers.filter((node) => node.id !== 4);

    const assessment = assessFirmwareReconstruction(graph);

    expect(assessment.traceComplete).toBe(false);
    expect(assessment.blockers[0]).toMatch(/incomplete path/);
  });

  it("refuses an edge that does not fit inside its parent buffer", () => {
    const graph = traceableGraph();
    const nested = graph.buffers.find((node) => node.id === 9);
    if (!nested?.parent) throw new Error("expected the nested buffer");
    nested.parent.sectionEnd = 0x1000;

    expect(assessFirmwareReconstruction(graph).traceComplete).toBe(false);
  });

  it("refuses an artifact whose source file does not contain it", () => {
    const graph = traceableGraph();
    graph.artifacts[0].sourceFile.bufferId = 9;
    graph.artifacts[0].sourceFile.volumeEnd = 0x180;
    graph.artifacts[0].sourceFile.end = 0x28;

    expect(assessFirmwareReconstruction(graph).traceComplete).toBe(false);
  });

  it("has nothing to trace without artifacts", () => {
    const assessment = assessFirmwareReconstruction({
      rootBufferId: 0,
      sourceSize: 0,
      buffers: [{ id: 0, bytes: new Uint8Array(), depth: 0 }],
      artifacts: [],
    });

    expect(assessment.traceComplete).toBe(false);
    expect(assessment.traces).toEqual([]);
  });
});
