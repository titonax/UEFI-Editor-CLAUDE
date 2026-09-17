import type { FirmwareSectionCompression } from "./firmwareSections";

export type FirmwareArtifactKind = "setup-hii" | "amitse" | "setupdata";

// The FFS file (inside a specific decoded buffer) that an artifact or an
// encapsulation section was found in, with every boundary needed to put a
// rebuilt body back exactly where it came from.
export interface FirmwareFileReference {
  bufferId: number;
  guid: string;
  volumeStart: number;
  volumeEnd: number;
  fileStart: number;
  bodyStart: number;
  end: number;
  headerSize: number;
}

// How one decoded buffer was produced from its parent: the encapsulation
// section it came out of, and the compression that has to be reproduced to
// put it back.
export interface FirmwareEncapsulationEdge {
  parentBufferId: number;
  sectionStart: number;
  sectionEnd: number;
  sectionHeaderSize: number;
  sectionType: number;
  payloadStart: number;
  payloadEnd: number;
  compression: FirmwareSectionCompression;
  definitionGuid?: string;
  attributes?: number;
  ownerFile?: FirmwareFileReference;
}

// Buffer 0 is always the untouched source image; every other buffer has
// exactly one parent edge.
export interface FirmwareBufferNode {
  id: number;
  bytes: Uint8Array;
  depth: number;
  parent?: FirmwareEncapsulationEdge;
}

export interface FirmwareArtifactLocation {
  kind: FirmwareArtifactKind;
  bufferId: number;
  payloadStart: number;
  payloadEnd: number;
  sourceFile: FirmwareFileReference;
}

export interface FirmwareProvenanceGraph {
  rootBufferId: 0;
  sourceSize: number;
  buffers: FirmwareBufferNode[];
  artifacts: FirmwareArtifactLocation[];
}

export interface FirmwareArtifactTrace {
  kind: FirmwareArtifactKind;
  complete: boolean;
  compressions: FirmwareSectionCompression[];
  labels: string[];
}

export interface FirmwareReconstructionAssessment {
  traceComplete: boolean;
  writeEnabled: false;
  traces: FirmwareArtifactTrace[];
  compressions: FirmwareSectionCompression[];
  blockers: string[];
}

const artifactLabels: Record<FirmwareArtifactKind, string> = {
  "setup-hii": "Setup HII",
  amitse: "AMITSE PE32",
  setupdata: "SetupData",
};

function hexOffset(value: number) {
  return `0x${value.toString(16).toUpperCase()}`;
}

function compressionLabel(compression: FirmwareSectionCompression) {
  if (compression === "lzma") return "LZMA section";
  if (compression === "standard") return "EFI/Tiano section";
  return "encapsulation section";
}

function isValidFileReference(
  file: FirmwareFileReference,
  nodes: Map<number, FirmwareBufferNode>,
) {
  const node = nodes.get(file.bufferId);
  return (
    node !== undefined &&
    file.volumeStart >= 0 &&
    file.fileStart >= file.volumeStart &&
    file.bodyStart === file.fileStart + file.headerSize &&
    file.end >= file.bodyStart &&
    file.end <= file.volumeEnd &&
    file.volumeEnd <= node.bytes.length
  );
}

// Walks one artifact's parent edges back to buffer 0, checking every hop
// still fits inside the buffer it claims to come from. Any inconsistency
// (a missing parent, a cycle, an edge outside its parent's bytes, a source
// file that doesn't contain the artifact) makes the trace incomplete - the
// point is to never claim a rebuild path that can't actually be replayed.
function traceArtifact(
  graph: FirmwareProvenanceGraph,
  artifact: FirmwareArtifactLocation,
): FirmwareArtifactTrace {
  const nodes = new Map(graph.buffers.map((node) => [node.id, node]));
  const edgesFromArtifact: FirmwareEncapsulationEdge[] = [];
  const visited = new Set<number>();
  const lineage = new Set<number>();
  let currentId = artifact.bufferId;
  let complete =
    artifact.payloadStart >= 0 &&
    artifact.payloadEnd >= artifact.payloadStart &&
    artifact.payloadEnd <= (nodes.get(artifact.bufferId)?.bytes.length ?? -1);

  while (currentId !== graph.rootBufferId) {
    if (visited.has(currentId)) {
      complete = false;
      break;
    }
    visited.add(currentId);
    lineage.add(currentId);
    const node = nodes.get(currentId);
    const parent = node?.parent ? nodes.get(node.parent.parentBufferId) : undefined;
    if (!node?.parent || !parent) {
      complete = false;
      break;
    }
    const edge = node.parent;
    if (
      edge.sectionStart < 0 ||
      edge.sectionEnd > parent.bytes.length ||
      edge.payloadStart < edge.sectionStart ||
      edge.payloadEnd > edge.sectionEnd
    ) {
      complete = false;
    }
    if (
      edge.ownerFile &&
      (edge.ownerFile.bufferId !== edge.parentBufferId ||
        !isValidFileReference(edge.ownerFile, nodes) ||
        edge.sectionStart < edge.ownerFile.bodyStart ||
        edge.sectionEnd > edge.ownerFile.end)
    ) {
      complete = false;
    }
    edgesFromArtifact.push(edge);
    currentId = edge.parentBufferId;
  }

  lineage.add(currentId);
  if (
    nodes.get(graph.rootBufferId)?.bytes.length !== graph.sourceSize ||
    nodes.size !== graph.buffers.length
  ) {
    complete = false;
  }
  if (
    !isValidFileReference(artifact.sourceFile, nodes) ||
    !lineage.has(artifact.sourceFile.bufferId) ||
    (artifact.bufferId === artifact.sourceFile.bufferId &&
      (artifact.payloadStart < artifact.sourceFile.bodyStart ||
        artifact.payloadEnd > artifact.sourceFile.end))
  ) {
    complete = false;
  }

  const edges = edgesFromArtifact.reverse();
  return {
    kind: artifact.kind,
    complete,
    compressions: edges.map((edge) => edge.compression),
    labels: [
      "Firmware image",
      ...edges.map(
        (edge) => `${compressionLabel(edge.compression)} @ ${hexOffset(edge.sectionStart)}`,
      ),
      artifactLabels[artifact.kind],
    ],
  };
}

// Full-image writing stays disabled until every layer between an edited
// artifact and the source image can be rebuilt deterministically and
// re-verified; until then this only reports whether the path is even known.
export function assessFirmwareReconstruction(
  graph: FirmwareProvenanceGraph,
): FirmwareReconstructionAssessment {
  const traces = graph.artifacts.map((artifact) => traceArtifact(graph, artifact));
  const compressions = [...new Set(traces.flatMap((trace) => trace.compressions))];
  const blockers: string[] = [];
  if (traces.length === 0 || traces.some((trace) => !trace.complete)) {
    blockers.push("At least one artifact has an incomplete path to the source image.");
  }
  if (compressions.includes("lzma")) {
    blockers.push("Deterministic LZMA recompression is not implemented yet.");
  }
  if (compressions.includes("standard")) {
    blockers.push("Deterministic EFI/Tiano recompression is not implemented yet.");
  }
  blockers.push(
    "Bottom-up section replacement, FFS checksum repair and full re-extraction verification are not implemented yet.",
  );

  return {
    traceComplete: traces.length > 0 && traces.every((trace) => trace.complete),
    writeEnabled: false,
    traces,
    compressions,
    blockers,
  };
}
