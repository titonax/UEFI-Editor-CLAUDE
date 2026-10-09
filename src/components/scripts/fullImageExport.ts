import type { PopulatedFiles } from "../FileUploads/fileModel";
import type { FirmwareDecompressor } from "./aptioIvExtractor";
import { computeModifiedFiles } from "./binaryPatcher";
import {
  rebuildFirmware,
  verifyByReextraction,
  type ArtifactEdit,
  type RebuildCodecs,
  type RebuiltFirmware,
} from "./firmwareRebuild";
import type { FirmwareArtifactKind, FirmwareArtifactSetSummary, FirmwareProvenanceGraph } from "./firmwareProvenance";
import { sha256Hex } from "./hashing";
import type { Data } from "./types";

// Full-image output (stage 4): the plan the editor applies to the extracted
// Setup / AMITSE / SetupData files, carried back into the complete firmware
// image it came from. Everything here is pure and runs off the main thread in
// the app (fullImageCheckWorker.ts); the decompressor and codecs are injected.

// One extracted file as it was and as the plan leaves it.
export interface ArtifactChange {
  kind: FirmwareArtifactKind;
  // The name the file has in the per-file export, for the changelog.
  fileName: string;
  original: Uint8Array;
  modified: Uint8Array;
  // What the plan did to this file, as the per-file changelog words it.
  changeLog: string;
}

export interface FullImageRequest {
  graph: FirmwareProvenanceGraph;
  artifactSetId: string;
  // The context (slot) the user chose; an image can hold several, and the
  // record has to say which one was patched.
  context: FirmwareArtifactSetSummary;
  // The uploaded file's name, for the changelog and the downloaded name.
  sourceName: string;
  changes: ArtifactChange[];
}

export type FullImageStage = "plan" | "rebuild" | "read-back" | "report";

export interface FullImageSummary {
  sourceSha256: string;
  outputSha256: string;
  imageBytes: number;
  changedBytes: number;
  changedRanges: number;
  repairedFiles: number;
  recompressedSections: number;
  // Sections whose file the source filled exactly and that now end before it,
  // and the erased bytes created after them: padding the firmware has not been
  // shown to accept.
  sectionsWithCreatedPadding: number;
  createdPaddingBytes: number;
}

export type FullImageResult =
  | {
      ok: true;
      image: Uint8Array;
      changelog: string;
      summary: FullImageSummary;
    }
  | {
      ok: false;
      stage: FullImageStage;
      // Why nothing was produced; every entry is shown to the user.
      messages: string[];
    };

export interface FullImageDeps {
  codecs: RebuildCodecs;
  // The decompressor the READ-BACK uses. In the app it is the project's
  // WebAssembly decoder, which shares no code with the encoders.
  decompress: FirmwareDecompressor;
}

// Gaps of up to this many bytes between two differing runs are bridged into one edit: the
// bytes between are the original's own, so the result is the same and the plan
// stays short when a move rewrites many nearby bytes.
const bridgedGap = 16;

// "board.rom" -> "board-modified.rom"; a name with no extension just gets the suffix.
export function modifiedImageName(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-modified${name.slice(dot)}` : `${name}-modified`;
}

export type EditPlan = { ok: true; edits: ArtifactEdit[] } | { ok: false; message: string };

function differingRuns(original: Uint8Array, modified: Uint8Array) {
  const runs: { start: number; end: number }[] = [];
  for (let index = 0; index < original.length; index++) {
    if (original[index] === modified[index]) continue;
    const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (last && index - last.end <= bridgedGap) last.end = index + 1;
    else runs.push({ start: index, end: index + 1 });
  }
  return runs;
}

// Turns the per-file results into same-size edits of the provenance graph's
// artifacts. Refuses, with the reason, anything it cannot place exactly.
export function planArtifactEdits(graph: FirmwareProvenanceGraph, changes: ArtifactChange[]): EditPlan {
  const edits: ArtifactEdit[] = [];
  for (const change of changes) {
    if (change.original.length !== change.modified.length) {
      return {
        ok: false,
        message: `${change.fileName}: the plan changes its length (${String(change.original.length)} to ${String(change.modified.length)} bytes); a complete image can only take same-size changes to it.`,
      };
    }
    const artifactIndex = graph.artifacts.findIndex((artifact) => artifact.kind === change.kind);
    const artifact = artifactIndex < 0 ? undefined : graph.artifacts[artifactIndex];
    if (!artifact) {
      return { ok: false, message: `${change.fileName}: the image's provenance has no ${change.kind} artifact to put it back into.` };
    }
    const node = graph.buffers.find((buffer) => buffer.id === artifact.bufferId);
    const inImage = node?.bytes.subarray(artifact.payloadStart, artifact.payloadEnd);
    const holdsIt = inImage?.length === change.original.length && inImage.every((byte, index) => byte === change.original[index]);
    if (!holdsIt) {
      return {
        ok: false,
        message: `${change.fileName}: the extracted file is not what the image holds at ${change.kind}'s location, so the edits cannot be placed.`,
      };
    }
    for (const run of differingRuns(change.original, change.modified)) {
      edits.push({
        artifactIndex,
        offset: run.start,
        expected: change.original.slice(run.start, run.end),
        replacement: change.modified.slice(run.start, run.end),
      });
    }
  }
  return { ok: true, edits };
}

// What the applied plan does to each extracted file, ready for the check.
// Throws what the per-file export throws (for example a pending root
// visibility plan), so both paths refuse the same plans for the same reasons.
export function changesFromPlan(data: Data, files: PopulatedFiles): ArtifactChange[] {
  const source = files.firmwareSource;
  if (!source) throw new Error("These files did not come from a complete firmware image.");
  const modified = computeModifiedFiles(data, files);
  const changes: ArtifactChange[] = [];
  const add = (
    kind: FirmwareArtifactKind,
    fileName: string,
    original: Uint8Array | undefined,
    result: Uint8Array,
    changed: boolean,
    changeLog: string,
  ) => {
    if (!changed) return;
    if (!original) throw new Error(`The image has no ${kind} artifact, but the plan changes it.`);
    changes.push({ kind, fileName, original, modified: result, changeLog });
  };
  add("setup-hii", files.setupSctContainer.file.name, source.artifacts.hii, modified.setupSct, modified.wasSetupSctModified, modified.setupSctChangeLog);
  add("amitse", files.amitseSctContainer.file.name, source.artifacts.amitse, modified.amitseSct, modified.wasAmitseSctModified, modified.amitseSctChangeLog);
  add("setupdata", files.setupdataBinContainer.file.name, source.artifacts.setupData, modified.setupdataBin, modified.wasSetupdataBinModified, modified.setupdataBinChangeLog);
  return changes;
}

function hexOffset(value: number) {
  return `0x${value.toString(16).toUpperCase()}`;
}

function buildChangelog(request: FullImageRequest, rebuilt: RebuiltFirmware, summary: FullImageSummary) {
  const lines: string[] = [];
  lines.push(`Firmware image: ${request.sourceName}`);
  lines.push(`Source SHA-256: ${summary.sourceSha256}`);
  lines.push(`Output SHA-256: ${summary.outputSha256}`);
  lines.push(`Image size: ${String(summary.imageBytes)} bytes (unchanged)`);
  lines.push(`Firmware context patched: ${request.context.label} (${request.context.id}), ${request.context.coherence}`);
  for (const warning of request.context.warnings) lines.push(`  Warning: ${warning}`);
  lines.push("");
  lines.push("Checks passed before this image was offered:");
  lines.push("  - every edit applied to its decoded buffer and carried up through each section to the image;");
  lines.push("  - every changed byte explained by an edit, a repaired checksum or a rebuilt section;");
  lines.push("  - the rebuilt image read back with the project's own decoders: every artifact is the source's with exactly these edits.");
  lines.push("NOT tested: this image has not been flashed or booted. Passing these checks proves the structure, not that the board accepts it.");
  if (summary.sectionsWithCreatedPadding > 0) {
    lines.push(
      `CREATED PADDING: in ${String(summary.sectionsWithCreatedPadding)} section(s) the source left less than a section header of room after the section in its FFS file, and the re-encoded stream is shorter, so ${String(summary.createdPaddingBytes)} byte(s) of erased padding (0xFF, the polarity the volume declares) now follow it inside the same file. The firmware has not been shown to accept padding there.`,
    );
  }
  lines.push("");
  for (const change of request.changes) {
    lines.push(`========== ${change.fileName} ==========`, "", change.changeLog.trimEnd(), "", "");
  }
  lines.push("========== Image-level changes ==========", "");
  lines.push(`Changed bytes: ${String(summary.changedBytes)} in ${String(summary.changedRanges)} range(s)`);
  for (const range of rebuilt.changedRanges.slice(0, 64)) {
    lines.push(`  ${hexOffset(range.start)}-${hexOffset(range.end)}`);
  }
  if (rebuilt.changedRanges.length > 64) lines.push(`  … ${String(rebuilt.changedRanges.length - 64)} more range(s)`);
  for (const file of rebuilt.repairedFiles.filter((one) => one.changed)) {
    lines.push(`FFS data checksum repaired: ${file.guid} at ${hexOffset(file.fileStart)} of decoded buffer ${String(file.bufferId)}`);
  }
  for (const change of rebuilt.layoutChanges) {
    const format = change.format === "lzma" ? "LZMA" : "EFI/Tiano";
    lines.push(
      `${format} section re-encoded at ${hexOffset(change.sectionStart)} of decoded buffer ${String(change.parentBufferId)}: ${String(change.packedBefore)} -> ${String(change.packedAfter)} bytes, erased padding after it ${String(change.paddingBefore)} -> ${String(change.paddingAfter)} bytes (the file keeps its size)${change.createdPadding ? " [CREATED PADDING]" : ""}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// Rebuilds the image with the plan, then checks the result twice, the second
// time independently of how it was built. Produces nothing unless both pass.
export async function checkFullImageOutput(given: FullImageRequest, deps: FullImageDeps): Promise<FullImageResult> {
  // The bytes decide, not the flags: a file the plan "changed" to what it
  // already was would otherwise be listed in the changelog with no effect. A
  // change of length stays, for the planner to refuse.
  const request: FullImageRequest = {
    ...given,
    changes: given.changes.filter(
      (change) =>
        change.original.length !== change.modified.length ||
        change.original.some((byte, index) => byte !== change.modified[index]),
    ),
  };
  if (request.changes.length === 0) {
    return { ok: false, stage: "plan", messages: ["The applied plan changes nothing in Setup, AMITSE or SetupData, so there is nothing to put into the image."] };
  }
  if (typeof crypto === "undefined" || !("subtle" in crypto)) {
    // The record of the output needs SHA-256, which the browser only offers on
    // https or localhost; better to say so before the long work than after.
    return { ok: false, stage: "plan", messages: ["This page cannot compute SHA-256 (Web Crypto needs https or localhost), and the changelog must carry the image's hashes."] };
  }
  const plan = planArtifactEdits(request.graph, request.changes);
  if (!plan.ok) return { ok: false, stage: "plan", messages: [plan.message] };
  if (plan.edits.length === 0) {
    return { ok: false, stage: "plan", messages: ["The applied plan leaves every byte of Setup, AMITSE and SetupData as it was, so there is nothing to put into the image."] };
  }

  const rebuilt = rebuildFirmware(request.graph, plan.edits, { codecs: deps.codecs });
  if (!rebuilt.ok) {
    return { ok: false, stage: "rebuild", messages: rebuilt.refusals.map((refusal) => refusal.message) };
  }
  // rebuildFirmware has already run the structural verification on its own
  // result and refuses (verification-failed) if it finds anything; the
  // independent half is the read-back below.

  const readBack = await verifyByReextraction(request.graph, plan.edits, rebuilt.value.image, {
    artifactSetId: request.artifactSetId,
    decompress: deps.decompress,
  });
  if (readBack.length > 0) return { ok: false, stage: "read-back", messages: readBack };

  const root = request.graph.buffers.find((buffer) => buffer.id === request.graph.rootBufferId);
  if (!root) return { ok: false, stage: "report", messages: ["The provenance graph has no source image to describe."] };
  let sourceSha256: string;
  let outputSha256: string;
  try {
    sourceSha256 = await sha256Hex(root.bytes);
    outputSha256 = await sha256Hex(rebuilt.value.image);
  } catch (error) {
    // Hashing is part of the record the changelog must carry; without it the
    // image is not offered.
    return { ok: false, stage: "report", messages: [error instanceof Error ? error.message : String(error)] };
  }
  const summary: FullImageSummary = {
    sourceSha256,
    outputSha256,
    imageBytes: rebuilt.value.image.length,
    changedBytes: rebuilt.value.changedBytes,
    changedRanges: rebuilt.value.changedRanges.length,
    repairedFiles: rebuilt.value.repairedFiles.filter((file) => file.changed).length,
    recompressedSections: rebuilt.value.layoutChanges.length,
    sectionsWithCreatedPadding: rebuilt.value.layoutChanges.filter((change) => change.createdPadding).length,
    createdPaddingBytes: rebuilt.value.layoutChanges.filter((change) => change.createdPadding).reduce((total, change) => total + (change.paddingAfter - change.paddingBefore), 0),
  };
  return { ok: true, image: rebuilt.value.image, changelog: buildChangelog(request, rebuilt.value, summary), summary };
}
