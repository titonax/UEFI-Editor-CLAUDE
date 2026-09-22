// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import BiosImageUpload from "./BiosImageUpload";
import type { PopulatedFiles } from "../FileUploads/fileModel";
import type { AptioIvArtifacts } from "../scripts/aptioIvExtractor";
import type { PhoenixSetupMenu } from "../scripts/phoenixSetupTable";

const extractFirmwareInWorker = vi.hoisted(() => vi.fn());
const inspectPhoenixSetupMenu = vi.hoisted(() => vi.fn());

vi.mock("../scripts/aptioIvExtractorClient", () => ({
  extractFirmwareInWorker,
}));

vi.mock("../scripts/phoenixSetupMenu", () => ({
  inspectPhoenixSetupMenu,
}));

function hexBytes(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

// A checksum-valid FFS2 volume carrying only the AMITSESetup marker, so
// the outer scan sees AMI evidence but no Setup/AMITSE FFS (deep scan
// required).
function validFirmwareVolumeImage() {
  const bytes = new Uint8Array(0x180);
  const view = new DataView(bytes.buffer);
  bytes.set(hexBytes("78E58C8C3D8A1C4F9935896185C32DD3"), 0x10);
  view.setBigUint64(0x20, 0x100n, true);
  bytes.set([0x5f, 0x46, 0x56, 0x48], 0x28);
  view.setUint16(0x30, 0x38, true);
  bytes.set(new TextEncoder().encode("AMITSESetup"), 0x60);
  let checksum = 0;
  for (let offset = 0; offset < 0x38; offset += 2) {
    checksum = (checksum + view.getUint16(offset, true)) & 0xffff;
  }
  view.setUint16(0x32, -checksum & 0xffff, true);
  return bytes;
}

// A checksum-valid FFS2 volume carrying an Insyde copyright marker instead
// of an AMI one - a definitively non-AMI vendor with a valid firmware
// volume, so the AMI-only deep extraction would otherwise be attempted.
function insydeFirmwareVolumeImage() {
  const bytes = new Uint8Array(0x180);
  const view = new DataView(bytes.buffer);
  bytes.set(hexBytes("78E58C8C3D8A1C4F9935896185C32DD3"), 0x10);
  view.setBigUint64(0x20, 0x100n, true);
  bytes.set([0x5f, 0x46, 0x56, 0x48], 0x28);
  view.setUint16(0x30, 0x38, true);
  bytes.set(new TextEncoder().encode("Insyde Software Corp."), 0x60);
  let checksum = 0;
  for (let offset = 0; offset < 0x38; offset += 2) {
    checksum = (checksum + view.getUint16(offset, true)) & 0xffff;
  }
  view.setUint16(0x32, -checksum & 0xffff, true);
  return bytes;
}

// One Forms Package whose FormSet uses AMI's unified Setup GUID.
function unifiedFormsPackage() {
  const bytes = new Uint8Array(37);
  bytes.set([37, 0, 0, 0x02, 0x0e, 0x97], 0);
  bytes.set(hexBytes("4A10597B0DC0584187FFF04D6396A915"), 6);
  bytes.set([0x01, 0x86, 0x10, 0x27, 0, 0], 27);
  bytes.set([0x29, 0x02, 0x29, 0x02], 33);
  return bytes;
}

function setupDataProfile() {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode("$SPF"), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 0x200, true);
  view.setUint32(8, 0x210, true);
  return bytes;
}

function artifactsFor(sourceImage: Uint8Array): AptioIvArtifacts {
  const hii = unifiedFormsPackage();
  const setupFile = {
    bufferId: 0,
    guid: "899407D7-99FE-43D8-9A21-79EC328CAC21",
    volumeStart: 0,
    volumeEnd: 0x100,
    fileStart: 0x28,
    bodyStart: 0x40,
    end: 0x100,
    headerSize: 24,
  };
  return {
    hii,
    ifrText: "verbose IFR",
    amitse: new Uint8Array([1]),
    setupData: setupDataProfile(),
    formPackageCount: 1,
    extractionDepth: 2,
    artifactSets: [
      {
        id: "buffer-0-fv-0-ffs-28",
        label: "Firmware context 1 · layer 0 · buffer 0 · FV 0x0",
        coherence: "same-firmware-volume",
        setupFile,
        warnings: [],
      },
    ],
    selectedArtifactSetId: "buffer-0-fv-0-ffs-28",
    provenance: {
      rootBufferId: 0,
      sourceSize: sourceImage.length,
      buffers: [{ id: 0, bytes: sourceImage, depth: 0 }],
      artifacts: [
        {
          kind: "setup-hii",
          bufferId: 0,
          payloadStart: 0x40,
          payloadEnd: 0x40 + hii.length,
          sourceFile: {
            bufferId: 0,
            guid: "899407D7-99FE-43D8-9A21-79EC328CAC21",
            volumeStart: 0,
            volumeEnd: 0x100,
            fileStart: 0x28,
            bodyStart: 0x40,
            end: 0x100,
            headerSize: 24,
          },
        },
      ],
    },
  };
}

function imageFile(bytes: Uint8Array, name: string) {
  const file = new File([bytes], name);
  // jsdom's File has no arrayBuffer() implementation.
  Object.defineProperty(file, "arrayBuffer", {
    value: () => Promise.resolve(bytes.slice().buffer),
  });
  return file;
}

function renderUpload(onExtracted: (files: PopulatedFiles) => Promise<void>) {
  const { container } = render(
    <MantineProvider>
      <BiosImageUpload onExtracted={onExtracted} />
    </MantineProvider>,
  );
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("expected the firmware file input");
  return input;
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
  // The Phoenix Setup menu panel's ScrollArea observes its own size; jsdom
  // has no ResizeObserver implementation.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  // Mantine's Combobox (the Pick Field option Select) scrolls the active
  // option into view; jsdom has no scrollIntoView implementation at all.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  extractFirmwareInWorker.mockReset();
  inspectPhoenixSetupMenu.mockReset();
  inspectPhoenixSetupMenu.mockResolvedValue(null);
});

inspectPhoenixSetupMenu.mockResolvedValue(null);

describe("BiosImageUpload", () => {
  it("accepts any filename, deep-scans once, and only hands over on Start", async () => {
    const sourceImage = validFirmwareVolumeImage();
    extractFirmwareInWorker.mockResolvedValueOnce(artifactsFor(sourceImage));
    const onExtracted = vi
      .fn<(files: PopulatedFiles) => Promise<void>>()
      .mockResolvedValue(undefined);
    const input = renderUpload(onExtracted);
    expect(input).not.toHaveAttribute("accept");

    fireEvent.change(input, { target: { files: [imageFile(sourceImage, "board.F13d")] } });

    expect(
      await screen.findByText("AMI Aptio V — probable HII profile"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Found · field \+0x04 0x0200/)).toBeInTheDocument();
    expect(screen.getByText(/2 nested layer/)).toBeInTheDocument();
    expect(screen.getByText("1 package(s) · 1 FormSet GUID(s) · unified Setup profile")).toBeInTheDocument();
    expect(screen.getByText("Reconstruction trace")).toBeInTheDocument();
    expect(
      screen.getByText("Full-image reconstruction — trace captured"),
    ).toBeInTheDocument();
    expect(screen.getByText("local deep scan complete")).toBeInTheDocument();
    expect(screen.getByText("Raw firmware volume image")).toBeInTheDocument();
    expect(screen.getByText("probable confidence")).toBeInTheDocument();
    expect(extractFirmwareInWorker).toHaveBeenCalledOnce();
    expect(onExtracted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start HII analysis" }));
    await waitFor(() => {
      expect(onExtracted).toHaveBeenCalledOnce();
    });
    const files = onExtracted.mock.calls[0][0];
    expect(files.firmwareSource?.fileName).toBe("board.F13d");
    expect(files.setupSctContainer.textContent).toBe(
      Array.from(unifiedFormsPackage(), (byte) =>
        byte.toString(16).toUpperCase().padStart(2, "0"),
      ).join(""),
    );
    expect(files.setupTxtContainer.textContent).toBe("verbose IFR");
    expect(extractFirmwareInWorker).toHaveBeenCalledOnce();
  });

  it("requires an explicit slot choice when repeated Setup contexts exist", async () => {
    const hii = unifiedFormsPackage();
    const sourceImage = validFirmwareVolumeImage();
    const setupFile = {
      bufferId: 0,
      guid: "899407D7-99FE-43D8-9A21-79EC328CAC21",
      volumeStart: 0,
      volumeEnd: 0x100,
      fileStart: 0x28,
      bodyStart: 0x40,
      end: 0x100,
      headerSize: 24,
    };
    extractFirmwareInWorker.mockResolvedValueOnce({
      hii,
      ifrText: "verbose IFR",
      formPackageCount: 1,
      extractionDepth: 2,
      artifactSets: [
        {
          id: "slot-1",
          label: "Firmware context 1 · layer 2 · buffer 4 · FV 0x0",
          coherence: "same-firmware-volume",
          setupFile,
          warnings: [],
        },
        {
          id: "slot-2",
          label: "Firmware context 2 · layer 2 · buffer 9 · FV 0x0",
          coherence: "same-firmware-volume",
          setupFile: { ...setupFile, bufferId: 9 },
          warnings: [],
        },
      ],
      selectedArtifactSetId: "slot-1",
      provenance: {
        rootBufferId: 0,
        sourceSize: sourceImage.length,
        buffers: [{ id: 0, bytes: sourceImage, depth: 0 }],
        artifacts: [
          {
            kind: "setup-hii",
            bufferId: 0,
            payloadStart: 0x40,
            payloadEnd: 0x40 + hii.length,
            sourceFile: setupFile,
          },
        ],
      },
    });
    const onExtracted = vi
      .fn<(files: PopulatedFiles) => Promise<void>>()
      .mockResolvedValue(undefined);
    const input = renderUpload(onExtracted);

    fireEvent.change(input, { target: { files: [imageFile(sourceImage, "dual-slot.bin")] } });

    expect(
      await screen.findByText("Multiple firmware contexts detected"),
    ).toBeInTheDocument();
    const start = screen.getByText("Start HII analysis").closest("button");
    if (!start) throw new Error("Expected the Start HII analysis button.");
    expect(start).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Firmware context / slot"), {
      target: { value: "slot-1" },
    });
    await waitFor(() => expect(start).toBeEnabled());
    // slot-1 is already the extraction's own selectedArtifactSetId, so
    // choosing it back is a no-op that never re-invokes the worker.
    expect(extractFirmwareInWorker).toHaveBeenCalledOnce();
  });

  it("stops at the outer scan when the file holds no firmware volume", async () => {
    const onExtracted = vi.fn<(files: PopulatedFiles) => Promise<void>>();
    const input = renderUpload(onExtracted);

    fireEvent.change(input, {
      target: { files: [imageFile(new Uint8Array(0x100), "notes.txt")] },
    });

    expect(
      await screen.findByText("AMI Aptio — generation unresolved"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No valid UEFI firmware volumes were found/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start HII analysis" })).toBeDisabled();
    expect(extractFirmwareInWorker).not.toHaveBeenCalled();
  });

  it("shows a vendor summary instead of the AMI panel, and never attempts extraction, for a definitively non-AMI image", async () => {
    const input = renderUpload(vi.fn<(files: PopulatedFiles) => Promise<void>>());

    fireEvent.change(input, {
      target: { files: [imageFile(insydeFirmwareVolumeImage(), "image.bin")] },
    });

    expect(await screen.findByText("Insyde H2O")).toBeInTheDocument();
    expect(screen.getByText(/Evidence: Insyde Software Corp\./)).toBeInTheDocument();
    expect(screen.getByText("Raw firmware volume image")).toBeInTheDocument();
    expect(screen.queryByText("Setup FFS (outer image)")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start HII analysis" }),
    ).not.toBeInTheDocument();
    expect(extractFirmwareInWorker).not.toHaveBeenCalled();
  });

  it("shows the extraction error instead of the Start button being usable", async () => {
    extractFirmwareInWorker.mockRejectedValueOnce(
      new Error("Setup FFS was not found after recursive decompression."),
    );
    const input = renderUpload(vi.fn<(files: PopulatedFiles) => Promise<void>>());

    fireEvent.change(input, {
      target: { files: [imageFile(validFirmwareVolumeImage(), "image.bin")] },
    });

    expect(await screen.findByText("Firmware analysis failed")).toBeInTheDocument();
    expect(
      screen.getByText("Setup FFS was not found after recursive decompression."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start HII analysis" })).toBeDisabled();
  });

  it("shows the Phoenix Setup menu panel when a legacy Setup Table is found on a non-AMI image, in a screen list + selected-screen detail layout", async () => {
    const menu: PhoenixSetupMenu = {
      sections: [
        {
          offset: 0,
          items: [
            {
              type: "pick-field",
              offset: 0,
              length: 20,
              prompt: "F12 Boot Menu:",
              help: "Enabled or Disabled",
              options: ["Disabled", "Enabled"],
              rawBytes: new Uint8Array(20),
            },
          ],
        },
        {
          offset: 100,
          items: [
            {
              type: "pick-field",
              offset: 100,
              length: 20,
              prompt: "Quiet Boot:",
              help: null,
              options: ["Enabled", "Disabled"],
              rawBytes: new Uint8Array(20),
            },
          ],
        },
      ],
    };
    inspectPhoenixSetupMenu.mockResolvedValueOnce(menu);
    const input = renderUpload(vi.fn<(files: PopulatedFiles) => Promise<void>>());

    fireEvent.change(input, {
      target: { files: [imageFile(new Uint8Array(0x100), "phoenix.bin")] },
    });

    // A real Setup Table is itself Phoenix evidence - the AMI Aptio panel
    // must not show for an image this scan has already identified.
    expect(await screen.findByText("Phoenix Setup menu: 2 screen(s), 2 item(s)")).toBeInTheDocument();
    expect(screen.queryByText("AMI Aptio — generation unresolved")).not.toBeInTheDocument();
    expect(screen.getByText("PhoenixBIOS 4.0")).toBeInTheDocument();

    // The first screen is selected by default - no click needed to see it.
    expect(screen.getByText("F12 Boot Menu:")).toBeInTheDocument();
    expect(screen.getByText("Enabled or Disabled")).toBeInTheDocument();
    expect(screen.queryByText("Quiet Boot:")).not.toBeInTheDocument();

    // Switching screens swaps the detail pane's contents.
    fireEvent.click(screen.getByText("Screen 2"));
    expect(screen.queryByText("F12 Boot Menu:")).not.toBeInTheDocument();
    expect(screen.getByText("Quiet Boot:")).toBeInTheDocument();

    expect(inspectPhoenixSetupMenu).toHaveBeenCalledOnce();
  });

  it("lets a Pick Field's option selection be changed, staged only in this browser tab", async () => {
    const menu: PhoenixSetupMenu = {
      sections: [
        {
          offset: 0,
          items: [
            {
              type: "pick-field",
              offset: 0,
              length: 20,
              prompt: "F12 Boot Menu:",
              help: "Enabled or Disabled",
              options: ["Disabled", "Enabled"],
              rawBytes: new Uint8Array(20),
            },
          ],
        },
      ],
    };
    inspectPhoenixSetupMenu.mockResolvedValueOnce(menu);
    const input = renderUpload(vi.fn<(files: PopulatedFiles) => Promise<void>>());

    fireEvent.change(input, {
      target: { files: [imageFile(new Uint8Array(0x100), "phoenix.bin")] },
    });

    await screen.findByText("F12 Boot Menu:");
    // Mantine's Select also renders a hidden <input> mirroring the value
    // for form submission - the visible combobox input is the first match.
    const [select] = screen.getAllByDisplayValue("Disabled");
    fireEvent.click(select);
    const options = await screen.findAllByRole("option");
    fireEvent.click(options[1]);

    await screen.findAllByDisplayValue("Enabled");
    expect(select).toHaveValue("Enabled");
  });

  it("de-duplicates a Pick Field's option list before handing it to the Select, which rejects duplicate values outright", async () => {
    const menu: PhoenixSetupMenu = {
      sections: [
        {
          offset: 0,
          items: [
            {
              type: "pick-field",
              offset: 0,
              length: 24,
              prompt: "Malformed Field:",
              help: null,
              options: ["Disabled", "Disabled", "Enabled"],
              rawBytes: new Uint8Array(24),
            },
          ],
        },
      ],
    };
    inspectPhoenixSetupMenu.mockResolvedValueOnce(menu);
    const input = renderUpload(vi.fn<(files: PopulatedFiles) => Promise<void>>());

    fireEvent.change(input, {
      target: { files: [imageFile(new Uint8Array(0x100), "phoenix.bin")] },
    });

    // Mantine's Select throws (crashing the whole panel) if its `data`
    // array carries a repeated value - this only doesn't throw because the
    // duplicate "Disabled" entry was already collapsed to one.
    expect(await screen.findByText("Malformed Field:")).toBeInTheDocument();
  });

  it("never queries the Phoenix Setup Table for an AMI Aptio candidate", async () => {
    const sourceImage = validFirmwareVolumeImage();
    extractFirmwareInWorker.mockResolvedValueOnce(artifactsFor(sourceImage));
    const input = renderUpload(vi.fn<(files: PopulatedFiles) => Promise<void>>());

    fireEvent.change(input, { target: { files: [imageFile(sourceImage, "board.F13d")] } });

    expect(
      await screen.findByText("AMI Aptio V — probable HII profile"),
    ).toBeInTheDocument();
    expect(inspectPhoenixSetupMenu).not.toHaveBeenCalled();
  });

  it("refuses an image over the 512 MiB safety limit before reading it", async () => {
    const input = renderUpload(vi.fn<(files: PopulatedFiles) => Promise<void>>());
    const huge = new File([], "huge.bin");
    Object.defineProperty(huge, "size", { value: 512 * 1024 * 1024 + 1 });

    fireEvent.change(input, { target: { files: [huge] } });

    expect(
      await screen.findByText("The selected firmware exceeds the 512 MiB safety limit."),
    ).toBeInTheDocument();
    expect(extractFirmwareInWorker).not.toHaveBeenCalled();
  });
});
