import { ConsoleStdout, File as WasiFile, OpenFile, PreopenDirectory, WASI } from "@bjorn3/browser_wasi_shim";
import { decodeFailedPhrase, notSearchedPhrase } from "./extractionMessages";
import { type FirmwareArtifactLocation, type FirmwareArtifactSetSummary, type FirmwareProvenanceGraph } from "./firmwareProvenance";
import { amitseGuid, setupDataGuid, setupGuid } from "./aptioIvVolumes";
import { type FirmwareDecompressor, firmwareDecompress } from "./aptioIvDecompress";
import { type ExtractionGraph, locateArtifactSets, locateFirmwareFiles, maxSearchedBuffers } from "./aptioIvLocate";

export interface AptioIvArtifacts {
  hii: Uint8Array;
  ifrText: string;
  amitse?: Uint8Array;
  setupData?: Uint8Array;
  formPackageCount: number;
  extractionDepth: number;
  // Every coherent Setup/AMITSE/SetupData context this image contains (see
  // locateArtifactSets), and which one these artifacts came from. A modern
  // image can carry more than one firmware slot under the same AMI GUIDs -
  // GUID identity alone never proves two files belong to the same slot.
  artifactSets: FirmwareArtifactSetSummary[];
  selectedArtifactSetId: string;
  // Every decoded buffer on the way from the source image to each artifact,
  // kept so the root-visibility detector can read the Setup PE32 in place
  // and so a future full-image rebuild knows exactly what to put back where.
  provenance: FirmwareProvenanceGraph;
}


export interface AptioIvExtractionOptions {
  artifactSetId?: string;
}


// IFRExtractor names each output <base>.<formPackageIndex>.<stringPackageIndex>.<language>.uefi.ifr.txt.
// A real 32MB Aptio V image carried two en-US string packages for the same
// form package: one resolved every Prompt/Help/Text string, the other was a
// stale/broken table whose strings all came back the literal "InvalidId".
// Concatenating every variant means whichever text comes first wins -
// ifrParser.ts's forms.find() takes the first match at a given offset - so a
// broken table ahead of the real one silently replaces every label the user
// sees. Group by (form package, language) and keep only the least-broken
// variant instead of blindly concatenating all of them.
const ifrOutputNamePattern = /^.+\.(\d+)\.\d+\.([^.]+)\.uefi\.ifr\.txt$/;


export function selectBestIfrTexts(outputs: { name: string; text: string }[]) {
  const groups = new Map<string, { text: string; invalidIdCount: number }[]>();
  const ungrouped: string[] = [];
  for (const { name, text } of outputs) {
    const match = ifrOutputNamePattern.exec(name);
    if (!match) {
      ungrouped.push(text);
      continue;
    }
    const [, formPackage, language] = match;
    const key = `${formPackage}:${language}`;
    const variants = groups.get(key) ?? [];
    variants.push({ text, invalidIdCount: (text.match(/"InvalidId"/g) ?? []).length });
    groups.set(key, variants);
  }
  const selected = [...groups.values()].map(
    (variants) =>
      variants.reduce((best, candidate) =>
        candidate.invalidIdCount < best.invalidIdCount ? candidate : best,
      ).text,
  );
  return [...selected, ...ungrouped];
}


async function runIfrExtractor(hii: Uint8Array) {
  const directory = new Map<string, WasiFile>();
  directory.set("setup.bin", new WasiFile(hii));
  const stdout: string[] = [];
  const wasi = new WASI(
    ["ifrextractor", "setup.bin", "verbose"],
    [],
    [
      new OpenFile(new WasiFile([])),
      ConsoleStdout.lineBuffered((line) => stdout.push(line)),
      ConsoleStdout.lineBuffered((line) => stdout.push(line)),
      new PreopenDirectory(".", directory),
    ],
  );
  const url = `${import.meta.env.BASE_URL}ifrextractor.wasm`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("IFRExtractor WebAssembly is not available.");
  const module = await WebAssembly.compileStreaming(response);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  const exitCode = wasi.start(instance as WebAssembly.Instance & { exports: { memory: WebAssembly.Memory; _start: () => unknown } });
  if (exitCode !== 0) throw new Error(stdout.join("\n") || `IFRExtractor exited with ${String(exitCode)}.`);
  const outputs = [...directory.entries()]
    .filter(([name]) => name.endsWith(".ifr.txt"))
    .map(([name, output]) => ({ name, text: new TextDecoder().decode(output.data) }));
  if (outputs.length === 0) throw new Error("IFRExtractor did not generate a verbose IFR file.");
  return selectBestIfrTexts(outputs).join("\n");
}


// Only the source image and the buffers on some artifact's path back to it
// are kept; every other decoded buffer was a dead end and just costs memory.
function retainArtifactBranches(
  graph: ExtractionGraph,
  artifacts: FirmwareArtifactLocation[],
  sourceSize: number,
): FirmwareProvenanceGraph {
  const retained = new Set<number>([0]);
  for (const artifact of artifacts) {
    let bufferId = artifact.bufferId;
    while (!retained.has(bufferId)) {
      retained.add(bufferId);
      const parent = graph.nodes.get(bufferId)?.parent;
      if (!parent) break;
      bufferId = parent.parentBufferId;
    }
  }

  return {
    rootBufferId: 0,
    sourceSize,
    buffers: [...retained]
      .sort((left, right) => left - right)
      .flatMap((id) => {
        const node = graph.nodes.get(id);
        return node ? [node] : [];
      }),
    artifacts,
  };
}


export async function extractAptioIvBytes(
  image: Uint8Array,
  extractIfr: (hii: Uint8Array) => Promise<string> = runIfrExtractor,
  decompress: FirmwareDecompressor = firmwareDecompress,
  options: AptioIvExtractionOptions = {},
): Promise<AptioIvArtifacts> {
  const { graph, located: files } = await locateFirmwareFiles(
    image,
    [setupGuid, amitseGuid, setupDataGuid],
    decompress,
  );
  // A section that trapped or was rejected by the decompressor no longer
  // aborts the whole walk (see tryDecodeEncapsulation) - if that cost us the
  // only path to a Setup context, say so; otherwise it becomes a warning on
  // whichever context was still found, below.
  const unsearchedWarning =
    graph.unsearchedBuffers > 0
      ? `${String(graph.unsearchedBuffers)} decoded buffer(s) ${notSearchedPhrase} (limit ${String(maxSearchedBuffers)}); other firmware contexts may be missing.`
      : "";
  const decodeFailureContext = () =>
    (graph.decodeFailures.length > 0
      ? ` ${String(graph.decodeFailures.length)} section(s) ${decodeFailedPhrase}; first: ${graph.decodeFailures[0]}`
      : "") + (unsearchedWarning ? ` ${unsearchedWarning}` : "");
  if ((files.get(setupGuid) ?? []).length === 0) {
    throw new Error(
      `Setup FFS was not found after recursive decompression.${decodeFailureContext()}`,
    );
  }
  const sets = await locateArtifactSets(graph, files);
  if (sets.length === 0) {
    throw new Error(
      `No Setup context contains a usable HII package or Setup PE32 section.${decodeFailureContext()}`,
    );
  }
  if (graph.decodeFailures.length > 0) {
    const warning = `${String(graph.decodeFailures.length)} nested section(s) ${decodeFailedPhrase}; other firmware contexts may be missing. ${graph.decodeFailures[0]}`;
    for (const set of sets) set.summary.warnings.push(warning);
  }
  if (unsearchedWarning) {
    for (const set of sets) set.summary.warnings.push(unsearchedWarning);
  }
  const selected = options.artifactSetId
    ? sets.find((set) => set.summary.id === options.artifactSetId)
    : sets[0];
  if (!selected) {
    throw new Error("The selected firmware context no longer exists in this image.");
  }
  const ifrText = await extractIfr(selected.hii.bytes);
  const formPackageCount = (ifrText.match(/FormSet Guid:/g) ?? []).length;
  const locations = [
    selected.hii.location,
    selected.amitse?.location,
    selected.setupData?.location,
  ].filter((location): location is FirmwareArtifactLocation => location !== undefined);
  return {
    hii: selected.hii.bytes,
    ifrText,
    amitse: selected.amitse?.bytes,
    setupData: selected.setupData?.bytes,
    formPackageCount,
    extractionDepth: selected.setup.depth,
    artifactSets: sets.map((set) => set.summary),
    selectedArtifactSetId: selected.summary.id,
    provenance: retainArtifactBranches(graph, locations, image.length),
  };
}


export async function extractAptioIvArtifacts(
  file: File,
  options: AptioIvExtractionOptions = {},
): Promise<AptioIvArtifacts> {
  return extractAptioIvBytes(
    new Uint8Array(await file.arrayBuffer()),
    runIfrExtractor,
    firmwareDecompress,
    options,
  );
}

export { firmwareDecompress, type FirmwareDecompressor } from "./aptioIvDecompress";
