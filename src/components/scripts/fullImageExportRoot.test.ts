import { describe, expect, it } from "vitest";
import { extractAptioIvBytes, type FirmwareDecompressor } from "./aptioIvExtractor";
import { inspectAmiRootVisibility } from "./amiRootVisibility";
import { toggleAmiRootVisibility } from "./amiRootVisibilityEditing";
import { computeModifiedFiles } from "./binaryPatcher";
import {
  HII_GUID,
  SETUP_GUID,
  firmwareVolume,
  freeformSection,
  patternBytes,
  pe32Section,
  sectionStream,
} from "./firmwareImageFixtures";
import { changesFromPlan, checkFullImageOutput, rootChangesFromPlan, type FullImageRequest, type RootByteChange } from "./fullImageExport";
import { parseData } from "./ifrParser";
import { lzmaJsCodec } from "./lzmaJs";
import { buildPopulatedFilesFromArtifacts } from "./populatedFilesFromArtifacts";
import { buildFixtureFiles } from "./testFixtures";
import { buildPe, rootMenu } from "./rootVectorFixtures";
import type { AmiRootVisibilityEdit } from "./types";

const noIfr = () => Promise.resolve("");
const decompress: FirmwareDecompressor = (input, mode) =>
  mode === "lzma" ? Promise.resolve(lzmaJsCodec.decode(input)) : Promise.reject(new Error("no EFI/Tiano here"));
const deps = { codecs: { lzma: lzmaJsCodec }, decompress };
const checksummed = 0x40;

function image(values: number[]) {
  const body = sectionStream(freeformSection(HII_GUID, patternBytes(900, 5)), pe32Section(buildPe(values)));
  return firmwareVolume([{ guid: SETUP_GUID, attributes: checksummed, body }]);
}

async function opened(values = [1, 1, 1]) {
  const bytes = image(values);
  const artifacts = await extractAptioIvBytes(bytes, noIfr, decompress);
  const files = buildPopulatedFilesFromArtifacts(artifacts, "board.rom", "unresolved");
  const data = await parseData(await buildFixtureFiles());
  const report = inspectAmiRootVisibility(rootMenu(values.length), artifacts.provenance);
  if (report.status !== "detected" || !report.vector) throw new Error(`no vector: ${report.reason}`);
  data.rootVisibility = report;
  return { bytes, artifacts, files, data, report };
}

// The edit the UI would record for a click on this root (the real toggle).
function editOf(open: Awaited<ReturnType<typeof opened>>, rootIndex: number): AmiRootVisibilityEdit {
  const edits = toggleAmiRootVisibility(open.data, rootIndex);
  if (edits?.length !== 1) throw new Error("the toggle did not record exactly one edit");
  return edits[0];
}

function requestOf(open: Awaited<ReturnType<typeof opened>>, rootChanges: RootByteChange[]): FullImageRequest {
  return {
    graph: open.artifacts.provenance,
    artifactSetId: open.artifacts.selectedArtifactSetId,
    context: open.artifacts.artifactSets[0],
    sourceName: "board.rom",
    changes: [],
    rootChanges,
    rootReport: open.report,
  };
}

describe("root visibility in the complete image", () => {
  it("turns the plan into bytes of the Setup file and lets the full-image path carry it", async () => {
    const open = await opened();
    open.data.rootVisibilityEdits = [editOf(open, 1)];

    const { rootChanges, rootReport } = rootChangesFromPlan(open.data, open.files);

    expect(rootReport).toBe(open.report);
    expect(rootChanges).toHaveLength(1);
    expect(rootChanges[0]).toMatchObject({ expected: 1, replacement: 0, offset: open.report.entries[1].bufferOffset });
    // The per-file export still refuses it; the full-image path does not.
    expect(() => computeModifiedFiles(open.data, open.files)).toThrow(/full-image reconstruction/);
    // (the data here belongs to another fixture, so the planner may refuse for its own reasons)
    expect(() => changesFromPlan(open.data, open.files)).not.toThrow(/full-image reconstruction/);
  });

  it("refuses a plan that does not match the vector detected in this firmware", async () => {
    const open = await opened();
    const edit = editOf(open, 1);
    open.data.rootVisibilityEdits = [{ ...edit, expected: 0, replacement: 1 }];
    expect(() => rootChangesFromPlan(open.data, open.files)).toThrow(/root visibility/i);

    open.data.rootVisibilityEdits = [edit];
    open.data.rootVisibility = undefined;
    expect(() => rootChangesFromPlan(open.data, open.files)).toThrow(/detected vector/);
  });

  it("flips the byte, repairs the file checksum, reads the vector back and records it", async () => {
    const open = await opened();
    open.data.rootVisibilityEdits = [editOf(open, 1)];
    const { rootChanges } = rootChangesFromPlan(open.data, open.files);

    const result = await checkFullImageOutput(requestOf(open, rootChanges), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.rootBytesChanged).toBe(1);
    expect(result.summary.imageBytes).toBe(open.bytes.length);
    expect(result.changelog).toContain("Setup root visibility");
    expect(result.changelog).toContain("Hide root FormSet Root 1");
    expect(result.changelog).toContain("01 -> 00");
    const differing = [...result.image].flatMap((byte, index) => (byte !== open.bytes[index] ? [index] : []));
    expect(differing).toHaveLength(2); // the byte and the FFS data checksum
    const reopened = await extractAptioIvBytes(result.image, noIfr, decompress);
    const fresh = inspectAmiRootVisibility(rootMenu(3), reopened.provenance);
    expect(fresh.status === "detected" && fresh.entries.map((entry) => entry.value)).toEqual([1, 0, 1]);
  });

  it("refuses a plan that changes nothing and a root change given without its detection", async () => {
    const open = await opened();
    const same: RootByteChange = { ...rootChangesFromPlanFor(open), expected: 1, replacement: 1 };
    const nothing = await checkFullImageOutput(requestOf(open, [same]), deps);
    expect(nothing).toMatchObject({ ok: false, stage: "plan" });

    const change: RootByteChange = { ...same, replacement: 0 };
    const { rootReport: _omit, ...withoutReport } = requestOf(open, [change]);
    void _omit;
    const result = await checkFullImageOutput(withoutReport, deps);
    expect(result).toMatchObject({ ok: false, stage: "plan" });
    if (!result.ok) expect(result.messages[0]).toMatch(/without the detection/);
  });

  it("refuses at read-back when the fresh analysis does not agree with the detection it was given", async () => {
    const open = await opened();
    open.data.rootVisibilityEdits = [editOf(open, 1)];
    const { rootChanges } = rootChangesFromPlan(open.data, open.files);
    const request = requestOf(open, rootChanges);
    if (!request.rootReport?.vector) throw new Error("no vector");
    request.rootReport = { ...request.rootReport, vector: { ...request.rootReport.vector, offset: request.rootReport.vector.offset + 1 } };

    const result = await checkFullImageOutput(request, deps);

    expect(result).toMatchObject({ ok: false, stage: "read-back" });
    if (!result.ok) expect(result.messages.join(" ")).toMatch(/moved/);
  });
});

function rootChangesFromPlanFor(open: Awaited<ReturnType<typeof opened>>): RootByteChange {
  open.data.rootVisibilityEdits = [editOf(open, 1)];
  return rootChangesFromPlan(open.data, open.files).rootChanges[0];
}
