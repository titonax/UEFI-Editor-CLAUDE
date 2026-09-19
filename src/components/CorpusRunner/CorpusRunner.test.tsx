// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import CorpusRunner from "./CorpusRunner";
import { buildFixtureFiles } from "../scripts/testFixtures";
import type { AptioIvArtifacts } from "../scripts/aptioIvExtractor";

const extractFirmwareInWorker = vi.hoisted(() => vi.fn());

vi.mock("../scripts/aptioIvExtractorClient", () => ({
  extractFirmwareInWorker,
}));

// jsdom's File has no arrayBuffer() implementation (see BiosImageUpload's
// own per-instance workaround); CorpusRunner calls parseData() directly,
// which hashes every container file that way, and those File objects are
// built fresh inside buildPopulatedFilesFromArtifacts - too far from this
// test to stub per instance - so this polyfills it globally via the
// FileReader jsdom does implement.
if (typeof File.prototype.arrayBuffer !== "function") {
  File.prototype.arrayBuffer = function arrayBuffer(this: File) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(reader.result as ArrayBuffer);
      };
      reader.onerror = () => {
        reject(new Error("Could not read file."));
      };
      reader.readAsArrayBuffer(this);
    });
  };
}

function hexToBytes(hex: string) {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

// The same valid, parseable fixture binaryPatcher.test.ts/etc. use, wrapped
// as AptioIvArtifacts so buildPopulatedFilesFromArtifacts + parseData
// (which CorpusRunner really calls, unlike BiosImageUpload's own tests)
// succeed on it exactly like the rest of the suite's fixture-based tests.
async function fixtureArtifacts(): Promise<AptioIvArtifacts> {
  const files = await buildFixtureFiles();
  return {
    hii: hexToBytes(files.setupSctContainer.textContent),
    ifrText: files.setupTxtContainer.textContent,
    amitse: hexToBytes(files.amitseSctContainer.textContent),
    setupData: hexToBytes(files.setupdataBinContainer.textContent),
    formPackageCount: 1,
    extractionDepth: 0,
    artifactSets: [
      {
        id: "set-1",
        label: "Firmware context 1",
        coherence: "same-firmware-volume",
        setupFile: {
          bufferId: 0,
          guid: "899407D7-99FE-43D8-9A21-79EC328CAC21",
          volumeStart: 0,
          volumeEnd: 0x100,
          fileStart: 0x28,
          bodyStart: 0x40,
          end: 0x100,
          headerSize: 24,
        },
        warnings: [],
      },
    ],
    selectedArtifactSetId: "set-1",
    provenance: { rootBufferId: 0, sourceSize: 0x100, buffers: [], artifacts: [] },
  };
}

function firmwareFile(name: string) {
  const bytes = new Uint8Array(0x180);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0x20, 0x100n, true);
  bytes.set([0x5f, 0x46, 0x56, 0x48], 0x28);
  view.setUint16(0x30, 0x38, true);
  let checksum = 0;
  for (let offset = 0; offset < 0x38; offset += 2) {
    checksum = (checksum + view.getUint16(offset, true)) & 0xffff;
  }
  view.setUint16(0x32, -checksum & 0xffff, true);
  const file = new File([bytes], name);
  Object.defineProperty(file, "arrayBuffer", {
    value: () => Promise.resolve(bytes.slice().buffer),
  });
  return file;
}

beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  // Mantine's ScrollArea (used for the stage/editability detail tables)
  // observes its own size; jsdom has no ResizeObserver implementation.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterEach(() => {
  cleanup();
  extractFirmwareInWorker.mockReset();
});

describe("CorpusRunner", () => {
  it("analyses every selected file and reports its navigation/Hide-Show shape", async () => {
    extractFirmwareInWorker.mockResolvedValueOnce(await fixtureArtifacts());
    extractFirmwareInWorker.mockRejectedValueOnce(
      new Error("Setup FFS was not found after recursive decompression."),
    );
    const { container } = render(
      <MantineProvider>
        <CorpusRunner />
      </MantineProvider>,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("expected the corpus file input");

    fireEvent.change(input, {
      target: { files: [firmwareFile("board-a.bin"), firmwareFile("board-b.bin")] },
    });
    await waitFor(() => {
      expect(screen.getByText("2 file(s) selected · 768 B total")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Run local corpus analysis" }));

    await waitFor(() => {
      expect(screen.getByText("board-a.bin")).toBeInTheDocument();
      expect(screen.getByText("board-b.bin")).toBeInTheDocument();
    });
    // board-a.bin parses but has no detected single-FormSet navigation (a
    // generic two-Form fixture, no hub) -> "Partial"; board-b.bin's
    // extraction was rejected with the exact message extractAptioIvBytes
    // throws when no AMI Setup module is found, which the corpus runner
    // recognizes as a structurally-understood non-AMI image -> "Unsupported"
    // (not "Failed", which is reserved for genuinely unexpected errors).
    // Scoped to each file's own accordion item, since the summary metrics
    // grid also has "Partial"/"Unsupported" tile labels.
    const itemA = screen.getByText("board-a.bin").closest(".mantine-Accordion-item");
    const itemB = screen.getByText("board-b.bin").closest(".mantine-Accordion-item");
    if (!itemA || !itemB) throw new Error("expected both accordion items");
    await waitFor(() => {
      expect(within(itemA as HTMLElement).getByText("Partial")).toBeInTheDocument();
      expect(within(itemB as HTMLElement).getByText("Unsupported")).toBeInTheDocument();
    });
    expect(
      screen.getAllByText("Setup FFS was not found after recursive decompression.", {
        exact: false,
      }),
    ).not.toHaveLength(0);
    // board-b.bin has a valid FFS2 volume but no AMI markers at all, so the
    // vendor sniffer's fallback applies: recognized as UEFI, just not AMI.
    expect(
      within(itemB as HTMLElement).getAllByText(/Generic\/unbranded UEFI/).length,
    ).toBeGreaterThan(0);
    // The richer, GPT-matching per-file detail: size/container/generation,
    // form/ref counts, a stage table and a provenance badge, not just a
    // bare pass/fail chip.
    expect(screen.getByText(/forms .* refs/)).toBeInTheDocument();
    expect(screen.getByText(/provenance (complete|incomplete)/)).toBeInTheDocument();
    expect(screen.getAllByText(/\d+(\.\d+)? (B|KiB|MiB)/).length).toBeGreaterThan(0);
    expect(screen.getByText("Export JSON report")).toBeInTheDocument();
    expect(screen.getByText("Export CSV summary")).toBeInTheDocument();
    expect(extractFirmwareInWorker).toHaveBeenCalledTimes(2);
  });
});
