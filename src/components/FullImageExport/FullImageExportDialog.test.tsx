// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import FullImageExportDialog from "./FullImageExportDialog";
import type { PopulatedFiles } from "../FileUploads/fileModel";
import { extractAptioIvBytes, type FirmwareDecompressor } from "../scripts/aptioIvExtractor";
import { firmwareVolume, setupFiles } from "../scripts/firmwareImageFixtures";
import { checkFullImageOutput, modifiedImageName, type FullImageRequest, type FullImageResult } from "../scripts/fullImageExport";
import { parseData } from "../scripts/ifrParser";
import type { Data } from "../scripts/types";
import { buildFixtureFiles } from "../scripts/testFixtures";

const saveAsMock = vi.hoisted(() => vi.fn());
vi.mock("file-saver", () => ({
  saveAs: (blob: Blob, name: string) => {
    saveAsMock(blob, name);
  },
}));

beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
  // Mantine's ScrollArea observes its own size; jsdom has no ResizeObserver.
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
  saveAsMock.mockReset();
});

const noIfr = () => Promise.resolve("");
const noDecompress: FirmwareDecompressor = () => Promise.reject(new Error("not compressed"));

async function session(options: { unsuppress: boolean }) {
  const fixture = await buildFixtureFiles({ setupdataBin: "00000000", amitseSct: "" });
  const hii = Uint8Array.from(fixture.setupSctContainer.textContent.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  hii.set([0x29, 0x02], 0x1e);
  fixture.setupSctContainer.textContent = Array.from(hii, (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join("");
  const image = firmwareVolume(setupFiles({ hii, setupData: new Uint8Array(4) }, 0x40));
  const artifacts = await extractAptioIvBytes(image, noIfr, noDecompress);
  const files: PopulatedFiles = { ...fixture, firmwareSource: { fileName: "board.rom", artifacts, generation: "unresolved" } };
  const data: Data = await parseData(files);
  if (options.unsuppress) data.suppressions[0].active = false;
  return { files, data, image };
}

function renderDialog(props: Partial<React.ComponentProps<typeof FullImageExportDialog>> & Pick<React.ComponentProps<typeof FullImageExportDialog>, "files" | "appliedData">) {
  const view = render(
    <MantineProvider>
      <FullImageExportDialog opened onClose={() => undefined} planFingerprint="plan-1" {...props} />
    </MantineProvider>,
  );
  const again = (next: Partial<React.ComponentProps<typeof FullImageExportDialog>>) => {
    view.rerender(
      <MantineProvider>
        <FullImageExportDialog opened onClose={() => undefined} planFingerprint="plan-1" {...props} {...next} />
      </MantineProvider>,
    );
  };
  return { ...view, again };
}

const realCheck = (request: FullImageRequest) => ({
  result: checkFullImageOutput(request, { codecs: {}, decompress: noDecompress }),
  cancel: vi.fn(),
});

describe("FullImageExportDialog", () => {
  it("names what a passing check does not prove, before anything is run", async () => {
    const { files, data } = await session({ unsuppress: true });

    renderDialog({ files, appliedData: data, startCheck: realCheck });

    expect(screen.getByText("What a passing check does not prove")).toBeInTheDocument();
    expect(screen.getByText(/has not been flashed/)).toBeInTheDocument();
    expect(screen.getByText(/backup read of the chip/)).toBeInTheDocument();
    expect(screen.queryByText(/Download image/)).not.toBeInTheDocument();
  });

  it("checks the output, then offers the image and the changelog under their names", async () => {
    const { files, data, image } = await session({ unsuppress: true });
    renderDialog({ files, appliedData: data, startCheck: realCheck });

    fireEvent.click(screen.getByRole("button", { name: /Check firmware output/ }));

    await waitFor(() => {
      expect(screen.getByText("Checks passed")).toBeInTheDocument();
    });
    expect(screen.getByText("not flashed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Download image and changelog.txt/ }));
    expect(saveAsMock.mock.calls.map((call) => call[1] as string)).toEqual(["changelog.txt", "board-modified.rom"]);
    const [blob] = saveAsMock.mock.calls[1] as [Blob];
    const written = new Uint8Array(await blob.arrayBuffer());
    expect(written.length).toBe(image.length);
    expect(written).not.toEqual(image);
    const changelog = await (saveAsMock.mock.calls[0][0] as Blob).text();
    expect(changelog).toContain("Source SHA-256:");
    expect(changelog).toContain("Unsuppressed");
  });

  it("warns, before anything is downloaded, when the image has padding the source did not have", async () => {
    const { files, data } = await session({ unsuppress: true });
    const withPadding = (request: FullImageRequest): ReturnType<typeof realCheck> => ({
      result: checkFullImageOutput(request, { codecs: {}, decompress: noDecompress }).then((result) =>
        result.ok ? { ...result, summary: { ...result.summary, sectionsWithCreatedPadding: 1, createdPaddingBytes: 21806 } } : result,
      ),
      cancel: vi.fn(),
    });
    renderDialog({ files, appliedData: data, startCheck: withPadding });

    fireEvent.click(screen.getByRole("button", { name: /Check firmware output/ }));

    expect(await screen.findByText("This image has padding the source did not have")).toBeInTheDocument();
    expect(screen.getByText(/21806 byte\(s\) of erased padding/)).toBeInTheDocument();
  });

  it("does not warn about padding when none was created", async () => {
    const { files, data } = await session({ unsuppress: true });
    renderDialog({ files, appliedData: data, startCheck: realCheck });

    fireEvent.click(screen.getByRole("button", { name: /Check firmware output/ }));
    await screen.findByText("Checks passed");

    expect(screen.queryByText("This image has padding the source did not have")).not.toBeInTheDocument();
  });

  it("offers only the changelog on request", async () => {
    const { files, data } = await session({ unsuppress: true });
    renderDialog({ files, appliedData: data, startCheck: realCheck });
    fireEvent.click(screen.getByRole("button", { name: /Check firmware output/ }));
    await waitFor(() => {
      expect(screen.getByText("Checks passed")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /changelog.txt only/ }));

    expect(saveAsMock.mock.calls.map((call) => call[1] as string)).toEqual(["changelog.txt"]);
  });

  it("offers nothing when the check refuses, and says why", async () => {
    const { files, data } = await session({ unsuppress: true });
    const refusing = (): ReturnType<typeof realCheck> => ({
      result: Promise.resolve<FullImageResult>({ ok: false, stage: "rebuild", messages: ["The section at 0x40 has no room."] }),
      cancel: vi.fn(),
    });
    renderDialog({ files, appliedData: data, startCheck: refusing });

    fireEvent.click(screen.getByRole("button", { name: /Check firmware output/ }));

    await waitFor(() => {
      expect(screen.getByText("The image cannot be rebuilt or failed its own checks")).toBeInTheDocument();
    });
    expect(screen.getByText("The section at 0x40 has no room.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
  });

  it("does not offer a result once the applied plan has changed", async () => {
    const { files, data } = await session({ unsuppress: true });
    const view = renderDialog({ files, appliedData: data, startCheck: realCheck });
    fireEvent.click(screen.getByRole("button", { name: /Check firmware output/ }));
    await waitFor(() => {
      expect(screen.getByText("Checks passed")).toBeInTheDocument();
    });

    view.again({ planFingerprint: "plan-2" });

    expect(screen.getByText("This result is for an older plan")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
  });

  it("can be cancelled while it runs", async () => {
    const { files, data } = await session({ unsuppress: true });
    const cancel = vi.fn();
    renderDialog({ files, appliedData: data, startCheck: () => ({ result: new Promise<FullImageResult>(() => undefined), cancel }) });

    fireEvent.click(screen.getByRole("button", { name: /Check firmware output/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Cancel check/ }));

    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /Check firmware output/ })).toBeInTheDocument();
  });

  it("says why when the worker cannot even be started, instead of staying on running", async () => {
    const { files, data } = await session({ unsuppress: true });
    const throwing = () => {
      throw new Error("Workers are blocked.");
    };
    renderDialog({ files, appliedData: data, startCheck: throwing });

    fireEvent.click(screen.getByRole("button", { name: /Check firmware output/ }));

    expect(await screen.findByText("Workers are blocked.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel check/ })).not.toBeInTheDocument();
  });

  it("does not show a refusal as the verdict on a plan it was not run for", async () => {
    const { files, data } = await session({ unsuppress: true });
    const refusing = (): ReturnType<typeof realCheck> => ({
      result: Promise.resolve<FullImageResult>({ ok: false, stage: "rebuild", messages: ["Plan A has no room."] }),
      cancel: vi.fn(),
    });
    const view = renderDialog({ files, appliedData: data, startCheck: refusing });
    fireEvent.click(screen.getByRole("button", { name: /Check firmware output/ }));
    expect(await screen.findByText("Plan A has no room.")).toBeInTheDocument();

    view.again({ planFingerprint: "plan-2" });

    expect(screen.queryByText("Plan A has no room.")).not.toBeInTheDocument();
    expect(screen.getByText("This result is for an older plan")).toBeInTheDocument();
  });

  it("cancels a running check when the window is closed", async () => {
    const { files, data } = await session({ unsuppress: true });
    const cancel = vi.fn();
    const onClose = vi.fn();
    renderDialog({ files, appliedData: data, onClose, startCheck: () => ({ result: new Promise<FullImageResult>(() => undefined), cancel }) });
    fireEvent.click(screen.getByRole("button", { name: /Check firmware output/ }));
    await screen.findByRole("button", { name: /Cancel check/ });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await waitFor(() => {
      expect(cancel).toHaveBeenCalledOnce();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("says when the check itself could not run", async () => {
    const { files, data } = await session({ unsuppress: true });
    const crashing = () => ({ result: Promise.reject(new Error("The check timed out.")), cancel: vi.fn() });
    renderDialog({ files, appliedData: data, startCheck: crashing });

    fireEvent.click(screen.getByRole("button", { name: /Check firmware output/ }));

    await waitFor(() => {
      expect(screen.getByText("The check timed out.")).toBeInTheDocument();
    });
    expect(screen.getByText("The check could not run")).toBeInTheDocument();
  });

  it("refuses a plan that changes nothing in the image", async () => {
    const { files, data } = await session({ unsuppress: false });
    renderDialog({ files, appliedData: data, startCheck: realCheck });

    fireEvent.click(screen.getByRole("button", { name: /Check firmware output/ }));

    await waitFor(() => {
      expect(screen.getByText("The plan cannot be placed in the image")).toBeInTheDocument();
    });
    expect(screen.getByText(/changes nothing/)).toBeInTheDocument();
  });

  it("refuses a pending root visibility plan, as the per-file export does", async () => {
    const { files, data } = await session({ unsuppress: true });
    data.rootVisibilityEdits = [
      { kind: "set-root-visibility", rootIndex: 0, formId: "0x1", bufferId: 0, bufferOffset: 0x40, expected: 0, replacement: 1, description: "Show root" },
    ];
    renderDialog({ files, appliedData: data, startCheck: realCheck });

    fireEvent.click(screen.getByRole("button", { name: /Check firmware output/ }));

    await waitFor(() => {
      expect(screen.getByText(/verified full-image reconstruction path/)).toBeInTheDocument();
    });
  });

  it("renders nothing for files that did not come from a complete image", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    renderDialog({ files, appliedData: data, startCheck: realCheck });

    expect(screen.queryByText("Complete firmware image")).not.toBeInTheDocument();
  });
});

describe("modifiedImageName", () => {
  it("puts the suffix before the extension", () => {
    expect(modifiedImageName("board.rom")).toBe("board-modified.rom");
    expect(modifiedImageName("a.b.cap")).toBe("a.b-modified.cap");
    expect(modifiedImageName("BIOS")).toBe("BIOS-modified");
    expect(modifiedImageName(".hidden")).toBe(".hidden-modified");
  });
});
